import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { R_OK } from 'node:constants';
import { Stats } from 'node:fs';
import path, { basename, parse } from 'node:path';
import picomatch from 'picomatch';
import { StorageCore } from 'src/cores/storage.core';
import { SystemConfigCore } from 'src/cores/system-config.core';
import {
  CreateLibraryDto,
  LibraryResponseDto,
  LibraryStatsResponseDto,
  ScanLibraryDto,
  UpdateLibraryDto,
  ValidateLibraryDto,
  ValidateLibraryImportPathResponseDto,
  ValidateLibraryResponseDto,
  mapLibrary,
} from 'src/dtos/library.dto';
import { AssetEntity, AssetType } from 'src/entities/asset.entity';
import { IAssetRepository, WithProperty } from 'src/interfaces/asset.interface';
import { ICryptoRepository } from 'src/interfaces/crypto.interface';
import { DatabaseLock, IDatabaseRepository } from 'src/interfaces/database.interface';
import { OnEvents, SystemConfigUpdateEvent } from 'src/interfaces/event.interface';
import {
  IBaseJob,
  IEntityJob,
  IJobRepository,
  ILibraryFileJob,
  ILibraryOfflineJob,
  ILibraryRefreshJob,
  JOBS_ASSET_PAGINATION_SIZE,
  JobName,
  JobStatus,
} from 'src/interfaces/job.interface';
import { ILibraryRepository } from 'src/interfaces/library.interface';
import { ILoggerRepository } from 'src/interfaces/logger.interface';
import { IStorageRepository } from 'src/interfaces/storage.interface';
import { ISystemMetadataRepository } from 'src/interfaces/system-metadata.interface';
import { mimeTypes } from 'src/utils/mime-types';
import { handlePromiseError } from 'src/utils/misc';
import { usePagination } from 'src/utils/pagination';
import { validateCronExpression } from 'src/validation';

const LIBRARY_SCAN_BATCH_SIZE = 1000;

@Injectable()
export class LibraryService implements OnEvents {
  private configCore: SystemConfigCore;
  private watchLibraries = false;
  private watchLock = false;
  private watchers: Record<string, () => Promise<void>> = {};

  constructor(
    @Inject(IAssetRepository) private assetRepository: IAssetRepository,
    @Inject(ISystemMetadataRepository) systemMetadataRepository: ISystemMetadataRepository,
    @Inject(ICryptoRepository) private cryptoRepository: ICryptoRepository,
    @Inject(IJobRepository) private jobRepository: IJobRepository,
    @Inject(ILibraryRepository) private repository: ILibraryRepository,
    @Inject(IStorageRepository) private storageRepository: IStorageRepository,
    @Inject(IDatabaseRepository) private databaseRepository: IDatabaseRepository,
    @Inject(ILoggerRepository) private logger: ILoggerRepository,
  ) {
    this.logger.setContext(LibraryService.name);
    this.configCore = SystemConfigCore.create(systemMetadataRepository, this.logger);
  }

  async onBootstrapEvent() {
    const config = await this.configCore.getConfig({ withCache: false });

    const { watch, scan } = config.library;

    // This ensures that library watching only occurs in one microservice
    // TODO: we could make the lock be per-library instead of global
    this.watchLock = await this.databaseRepository.tryLock(DatabaseLock.LibraryWatch);

    this.watchLibraries = this.watchLock && watch.enabled;

    this.jobRepository.addCronJob(
      'libraryScan',
      scan.cronExpression,
      () =>
        handlePromiseError(
          this.jobRepository.queue({ name: JobName.LIBRARY_QUEUE_SCAN_ALL, data: { force: false } }),
          this.logger,
        ),
      scan.enabled,
    );

    if (this.watchLibraries) {
      await this.watchAll();
    }

    this.configCore.config$.subscribe(({ library }) => {
      this.jobRepository.updateCronJob('libraryScan', library.scan.cronExpression, library.scan.enabled);

      if (library.watch.enabled !== this.watchLibraries) {
        // Watch configuration changed, update accordingly
        this.watchLibraries = library.watch.enabled;
        handlePromiseError(this.watchLibraries ? this.watchAll() : this.unwatchAll(), this.logger);
      }
    });
  }

  onConfigValidateEvent({ newConfig }: SystemConfigUpdateEvent) {
    const { scan } = newConfig.library;
    if (!validateCronExpression(scan.cronExpression)) {
      throw new Error(`Invalid cron expression ${scan.cronExpression}`);
    }
  }

  private async watch(id: string): Promise<boolean> {
    if (!this.watchLibraries) {
      return false;
    }

    const library = await this.findOrFail(id);
    if (library.importPaths.length === 0) {
      return false;
    }

    await this.unwatch(id);

    this.logger.log(`Starting to watch library ${library.id} with import path(s) ${library.importPaths}`);

    const matcher = picomatch(`**/*{${mimeTypes.getSupportedFileExtensions().join(',')}}`, {
      nocase: true,
      ignore: library.exclusionPatterns,
    });

    let _resolve: () => void;
    const ready$ = new Promise<void>((resolve) => (_resolve = resolve));

    this.watchers[id] = this.storageRepository.watch(
      library.importPaths,
      {
        usePolling: false,
        ignoreInitial: true,
      },
      {
        onReady: () => _resolve(),
        onAdd: (path) => {
          const handler = async () => {
            this.logger.debug(`File add event received for ${path} in library ${library.id}}`);
            if (matcher(path)) {
              await this.scanAssets(library.id, [path], library.ownerId, false);
            }
          };
          return handlePromiseError(handler(), this.logger);
        },
        onChange: (path) => {
          const handler = async () => {
            this.logger.debug(`Detected file change for ${path} in library ${library.id}`);
            if (matcher(path)) {
              // Note: if the changed file was not previously imported, it will be imported now.
              await this.scanAssets(library.id, [path], library.ownerId, false);
            }
          };
          return handlePromiseError(handler(), this.logger);
        },
        onUnlink: (path) => {
          const handler = async () => {
            this.logger.debug(`Detected deleted file at ${path} in library ${library.id}`);
            const asset = await this.assetRepository.getByLibraryIdAndOriginalPath(library.id, path);
            if (asset && matcher(path)) {
              await this.assetRepository.update({ id: asset.id, isOffline: true });
            }
          };
          return handlePromiseError(handler(), this.logger);
        },
        onError: (error) => {
          this.logger.error(`Library watcher for library ${library.id} encountered error: ${error}`);
        },
      },
    );

    // Wait for the watcher to initialize before returning
    await ready$;

    return true;
  }

  async unwatch(id: string) {
    if (this.watchers[id]) {
      await this.watchers[id]();
      delete this.watchers[id];
    }
  }

  async onShutdownEvent() {
    await this.unwatchAll();
  }

  private async unwatchAll() {
    if (!this.watchLock) {
      return false;
    }

    for (const id in this.watchers) {
      await this.unwatch(id);
    }
  }

  async watchAll() {
    if (!this.watchLock) {
      return false;
    }

    const libraries = await this.repository.getAll(false);
    for (const library of libraries) {
      await this.watch(library.id);
    }
  }

  async getStatistics(id: string): Promise<LibraryStatsResponseDto> {
    const statistics = await this.repository.getStatistics(id);
    if (!statistics) {
      throw new BadRequestException('Library not found');
    }
    return statistics;
  }

  async get(id: string): Promise<LibraryResponseDto> {
    const library = await this.findOrFail(id);
    return mapLibrary(library);
  }

  async getAll(): Promise<LibraryResponseDto[]> {
    const libraries = await this.repository.getAll(false);
    return libraries.map((library) => mapLibrary(library));
  }

  async handleQueueCleanup(): Promise<JobStatus> {
    this.logger.debug('Cleaning up any pending library deletions');
    const pendingDeletion = await this.repository.getAllDeleted();
    await this.jobRepository.queueAll(
      pendingDeletion.map((libraryToDelete) => ({ name: JobName.LIBRARY_DELETE, data: { id: libraryToDelete.id } })),
    );
    return JobStatus.SUCCESS;
  }

  async create(dto: CreateLibraryDto): Promise<LibraryResponseDto> {
    const library = await this.repository.create({
      ownerId: dto.ownerId,
      name: dto.name ?? 'New External Library',
      importPaths: dto.importPaths ?? [],
      exclusionPatterns: dto.exclusionPatterns ?? [],
    });
    return mapLibrary(library);
  }

  private async scanAssets(libraryId: string, assetPaths: string[], ownerId: string, force = false) {
    this.logger.verbose(`Queuing refresh of ${assetPaths.length} asset(s)`);

    await this.jobRepository.queueAll(
      assetPaths.map((assetPath) => ({
        name: JobName.LIBRARY_SCAN_ASSET,
        data: {
          id: libraryId,
          assetPath: assetPath,
          ownerId,
          force,
        },
      })),
    );
  }

  private async validateImportPath(importPath: string): Promise<ValidateLibraryImportPathResponseDto> {
    const validation = new ValidateLibraryImportPathResponseDto();
    validation.importPath = importPath;

    if (StorageCore.isImmichPath(importPath)) {
      validation.message = 'Cannot use media upload folder for external libraries';
      return validation;
    }

    try {
      const stat = await this.storageRepository.stat(importPath);
      if (!stat.isDirectory()) {
        validation.message = 'Not a directory';
        return validation;
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        validation.message = 'Path does not exist (ENOENT)';
        return validation;
      }
      validation.message = String(error);
      return validation;
    }

    const access = await this.storageRepository.checkFileExists(importPath, R_OK);

    if (!access) {
      validation.message = 'Lacking read permission for folder';
      return validation;
    }

    validation.isValid = true;
    return validation;
  }

  async validate(id: string, dto: ValidateLibraryDto): Promise<ValidateLibraryResponseDto> {
    const importPaths = await Promise.all(
      (dto.importPaths || []).map((importPath) => this.validateImportPath(importPath)),
    );
    return { importPaths };
  }

  async update(id: string, dto: UpdateLibraryDto): Promise<LibraryResponseDto> {
    await this.findOrFail(id);
    const library = await this.repository.update({ id, ...dto });

    if (dto.importPaths) {
      const validation = await this.validate(id, { importPaths: dto.importPaths });
      if (validation.importPaths) {
        for (const path of validation.importPaths) {
          if (!path.isValid) {
            throw new BadRequestException(`Invalid import path: ${path.message}`);
          }
        }
      }
    }

    return mapLibrary(library);
  }

  async delete(id: string) {
    await this.findOrFail(id);

    if (this.watchLibraries) {
      await this.unwatch(id);
    }

    await this.repository.softDelete(id);
    await this.jobRepository.queue({ name: JobName.LIBRARY_DELETE, data: { id } });
  }

  async handleDeleteLibrary(job: IEntityJob): Promise<JobStatus> {
    const library = await this.repository.get(job.id, true);
    if (!library) {
      return JobStatus.FAILED;
    }

    // TODO use pagination
    const assetIds = await this.repository.getAssetIds(job.id, true);
    this.logger.debug(`Will delete ${assetIds.length} asset(s) in library ${job.id}`);
    await this.jobRepository.queueAll(
      assetIds.map((assetId) => ({
        name: JobName.ASSET_DELETION,
        data: {
          id: assetId,
          deleteOnDisk: false,
        },
      })),
    );

    if (assetIds.length === 0) {
      this.logger.log(`Deleting library ${job.id}`);
      await this.repository.delete(job.id);
    }
    return JobStatus.SUCCESS;
  }

  async handleAssetRefresh(job: ILibraryFileJob): Promise<JobStatus> {
    const assetPath = path.normalize(job.assetPath);

    const existingAssetEntity = await this.assetRepository.getByLibraryIdAndOriginalPath(job.id, assetPath);

    let stats: Stats;
    try {
      stats = await this.storageRepository.stat(assetPath);
    } catch (error: Error | any) {
      // Can't access file, probably offline
      if (existingAssetEntity) {
        // Mark asset as offline
        this.logger.debug(`Marking asset as offline: ${assetPath}`);

        await this.assetRepository.update({ id: existingAssetEntity.id, isOffline: true });
        return JobStatus.SUCCESS;
      } else {
        // File can't be accessed and does not already exist in db
        throw new BadRequestException('Cannot access file', { cause: error });
      }
    }

    let doImport = false;
    let doRefresh = false;

    if (job.force) {
      doRefresh = true;
    }

    const originalFileName = parse(assetPath).base;

    if (!existingAssetEntity) {
      // This asset is new to us, read it from disk
      this.logger.debug(`Importing new asset: ${assetPath}`);
      doImport = true;
    } else if (stats.mtime.toISOString() !== existingAssetEntity.fileModifiedAt.toISOString()) {
      // File modification time has changed since last time we checked, re-read from disk
      this.logger.debug(
        `File modification time has changed, re-importing asset: ${assetPath}. Old mtime: ${existingAssetEntity.fileModifiedAt}. New mtime: ${stats.mtime}`,
      );
      doRefresh = true;
    } else if (existingAssetEntity.originalFileName !== originalFileName) {
      // TODO: We can likely remove this check in the second half of 2024 when all assets have likely been re-imported by all users
      this.logger.debug(
        `Asset is missing file extension, re-importing: ${assetPath}. Current incorrect filename: ${existingAssetEntity.originalFileName}.`,
      );
      doRefresh = true;
    } else if (!job.force && stats && !existingAssetEntity.isOffline) {
      // Asset exists on disk and in db and mtime has not changed. Also, we are not forcing refresn. Therefore, do nothing
      this.logger.debug(`Asset already exists in database and on disk, will not import: ${assetPath}`);
    }

    if (stats && existingAssetEntity?.isOffline) {
      // File was previously offline but is now online
      this.logger.debug(`Marking previously-offline asset as online: ${assetPath}`);
      await this.assetRepository.update({ id: existingAssetEntity.id, isOffline: false });
      doRefresh = true;
    }

    if (!doImport && !doRefresh) {
      // If we don't import, exit here
      return JobStatus.SKIPPED;
    }

    let assetType: AssetType;

    if (mimeTypes.isImage(assetPath)) {
      assetType = AssetType.IMAGE;
    } else if (mimeTypes.isVideo(assetPath)) {
      assetType = AssetType.VIDEO;
    } else {
      throw new BadRequestException(`Unsupported file type ${assetPath}`);
    }

    // TODO: doesn't xmp replace the file extension? Will need investigation
    let sidecarPath: string | null = null;
    if (await this.storageRepository.checkFileExists(`${assetPath}.xmp`, R_OK)) {
      sidecarPath = `${assetPath}.xmp`;
    }

    // TODO: device asset id is deprecated, remove it
    const deviceAssetId = `${basename(assetPath)}`.replaceAll(/\s+/g, '');

    let assetId;
    if (doImport) {
      const library = await this.repository.get(job.id, true);
      if (library?.deletedAt) {
        this.logger.error('Cannot import asset into deleted library');
        return JobStatus.FAILED;
      }

      const pathHash = this.cryptoRepository.hashSha1(`path:${assetPath}`);

      // TODO: In wait of refactoring the domain asset service, this function is just manually written like this
      const addedAsset = await this.assetRepository.create({
        ownerId: job.ownerId,
        libraryId: job.id,
        checksum: pathHash,
        originalPath: assetPath,
        deviceAssetId: deviceAssetId,
        deviceId: 'Library Import',
        fileCreatedAt: stats.mtime,
        fileModifiedAt: stats.mtime,
        localDateTime: stats.mtime,
        type: assetType,
        originalFileName,
        sidecarPath,
        isExternal: true,
      });
      assetId = addedAsset.id;
    } else if (doRefresh && existingAssetEntity) {
      assetId = existingAssetEntity.id;
      await this.assetRepository.updateAll([existingAssetEntity.id], {
        fileCreatedAt: stats.mtime,
        fileModifiedAt: stats.mtime,
        originalFileName,
      });
    } else {
      // Not importing and not refreshing, do nothing
      return JobStatus.SKIPPED;
    }

    this.logger.debug(`Queuing metadata extraction for: ${assetPath}`);

    await this.jobRepository.queue({ name: JobName.METADATA_EXTRACTION, data: { id: assetId, source: 'upload' } });

    if (assetType === AssetType.VIDEO) {
      await this.jobRepository.queue({ name: JobName.VIDEO_CONVERSION, data: { id: assetId } });
    }

    return JobStatus.SUCCESS;
  }

  async queueScan(id: string, dto: ScanLibraryDto) {
    await this.findOrFail(id);

    await this.jobRepository.queue({
      name: JobName.LIBRARY_SCAN,
      data: {
        id,
        refreshModifiedFiles: dto.refreshModifiedFiles ?? false,
        refreshAllFiles: dto.refreshAllFiles ?? false,
      },
    });
  }

  async queueRemoveOffline(id: string) {
    this.logger.verbose(`Removing offline files from library: ${id}`);
    await this.jobRepository.queue({ name: JobName.LIBRARY_REMOVE_OFFLINE, data: { id } });
  }

  async handleQueueAllScan(job: IBaseJob): Promise<JobStatus> {
    this.logger.debug(`Refreshing all external libraries: force=${job.force}`);

    // Queue cleanup
    await this.jobRepository.queue({ name: JobName.LIBRARY_QUEUE_CLEANUP, data: {} });

    // Queue all library refresh
    const libraries = await this.repository.getAll(true);
    await this.jobRepository.queueAll(
      libraries.map((library) => ({
        name: JobName.LIBRARY_SCAN,
        data: {
          id: library.id,
          refreshModifiedFiles: !job.force,
          refreshAllFiles: job.force ?? false,
        },
      })),
    );
    return JobStatus.SUCCESS;
  }

  // Checks if an online asset should be marked as offline, either due to missing path, or path outside of any import path
  async handleOfflineCheck(job: ILibraryOfflineJob): Promise<JobStatus> {
    const asset = await this.assetRepository.getById(job.id);

    if (!asset || asset.isOffline) {
      // We only care about online assets, we exit here if offline
      return JobStatus.SKIPPED;
    }

    const exists = await this.storageRepository.checkFileExists(asset.originalPath, R_OK);

    if (exists) {
      const isInPath = job.importPaths.find((path) => asset.originalPath.startsWith(path));

      if (isInPath) {
        // Asset path exists and is within an import path
        this.logger.verbose(`Asset is still online: ${asset.originalPath}`);
        return JobStatus.SUCCESS;
      }
    }

    // Either asset path does not exist, or it is outside of any import path
    this.logger.debug(`Marking asset as offline: ${asset.originalPath}`);
    await this.assetRepository.update({ id: asset.id, isOffline: true });

    return JobStatus.SUCCESS;
  }

  async handleOfflineRemoval(job: IEntityJob): Promise<JobStatus> {
    const assetPagination = usePagination(JOBS_ASSET_PAGINATION_SIZE, (pagination) =>
      this.assetRepository.getWith(pagination, WithProperty.IS_OFFLINE, job.id),
    );

    for await (const assets of assetPagination) {
      this.logger.debug(`Removing ${assets.length} offline assets`);
      await this.jobRepository.queueAll(
        assets.map((asset) => ({
          name: JobName.ASSET_DELETION,
          data: {
            id: asset.id,
            deleteOnDisk: false,
          },
        })),
      );
    }

    return JobStatus.SUCCESS;
  }

  async handleQueueAssetRefresh(job: ILibraryRefreshJob): Promise<JobStatus> {
    const library = await this.repository.get(job.id);
    if (!library) {
      this.logger.warn('Library not found');
      return JobStatus.FAILED;
    }

    this.logger.log(`Refreshing library: ${job.id}`);

    const validImportPaths: string[] = [];

    for (const importPath of library.importPaths) {
      const validation = await this.validateImportPath(importPath);
      if (validation.isValid) {
        validImportPaths.push(path.normalize(importPath));
      } else {
        this.logger.error(`Skipping invalid import path: ${importPath}. Reason: ${validation.message}`);
      }
    }

    const crawledAssets = this.storageRepository.walk({
      pathsToCrawl: validImportPaths,
      exclusionPatterns: library.exclusionPatterns,
    });

    let crawlDone = false;
    let crawlCounter = 0;
    let crawledAssetPaths: string[] = [];

    // (Re-)import all assets found on disk
    while (!crawlDone) {
      const assetGenerator = await crawledAssets.next();
      crawlDone = assetGenerator.done ?? true;

      if (!crawlDone) {
        crawledAssetPaths.push(assetGenerator.value);
        crawlCounter++;
      }

      if (crawledAssetPaths.length % LIBRARY_SCAN_BATCH_SIZE === 0 || crawlDone) {
        // We have reached the batch size or the end of the generator, scan the batch
        this.logger.log(`Queueing scan of ${crawledAssetPaths.length} crawled asset(s) in library ${library.id}...`);

        await this.scanAssets(job.id, crawledAssetPaths, library.ownerId, job.refreshAllFiles ?? false);
        crawlCounter += crawledAssetPaths.length;
        crawledAssetPaths = [];
      }
    }

    let existingAssetsDone = false;
    let existingAssetCounter = 0;
    const onlineAssets = usePagination(LIBRARY_SCAN_BATCH_SIZE, (pagination) =>
      this.assetRepository.getWith(pagination, WithProperty.IS_ONLINE, job.id),
    );

    // Check all existing online assets to see if they are still online
    while (!existingAssetsDone) {
      const existingAssetPage = await onlineAssets.next();
      existingAssetsDone = existingAssetPage.done ?? true;

      if (existingAssetPage.value) {
        existingAssetCounter += existingAssetPage.value.length;
        this.logger.log(
          `Queuing online check of ${existingAssetPage.value.length} asset(s) in library ${library.id}...`,
        );
        await this.jobRepository.queueAll(
          existingAssetPage.value.map((asset: AssetEntity) => ({
            name: JobName.LIBRARY_CHECK_OFFLINE,
            data: { id: asset.id, importPaths: validImportPaths },
          })),
        );
      }
    }

    this.logger.log(
      `Queued scan of ${crawlCounter} crawled and ${existingAssetCounter} existing asset(s) in library ${library.id}`,
    );

    await this.repository.update({ id: job.id, refreshedAt: new Date() });

    return JobStatus.SUCCESS;
  }

  private async findOrFail(id: string) {
    const library = await this.repository.get(id);
    if (!library) {
      throw new BadRequestException('Library not found');
    }
    return library;
  }
}
