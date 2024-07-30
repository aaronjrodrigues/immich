import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { AssetEntity } from 'src/entities/asset.entity';
import { StackEntity } from 'src/entities/stack.entity';
import { IStackRepository, StackSearch } from 'src/interfaces/stack.interface';
import { Instrumentation } from 'src/utils/instrumentation';
import { DataSource, In, Repository } from 'typeorm';

@Instrumentation()
@Injectable()
export class StackRepository implements IStackRepository {
  constructor(
    @InjectDataSource() private dataSource: DataSource,
    @InjectRepository(StackEntity) private repository: Repository<StackEntity>,
  ) {}

  search(query: StackSearch): Promise<StackEntity[]> {
    return this.repository.find({
      where: {
        ownerId: query.ownerId,
        primaryAssetId: query.primaryAssetId,
      },
      relations: {
        assets: {
          exifInfo: true,
        },
      },
    });
  }

  async create(entity: { ownerId: string; assetIds: string[] }): Promise<StackEntity> {
    return this.dataSource.manager.transaction(async (manager) => {
      const stackRepository = manager.getRepository(StackEntity);

      const stacks = await stackRepository.find({
        where: {
          ownerId: entity.ownerId,
          primaryAssetId: In(entity.assetIds),
        },
        select: {
          id: true,
          assets: {
            id: true,
          },
        },
        relations: {
          assets: {
            exifInfo: true,
          },
        },
      });

      const assetIds = new Set<string>(entity.assetIds);

      // children
      for (const stack of stacks) {
        for (const asset of stack.assets) {
          assetIds.add(asset.id);
        }
      }

      if (stacks.length > 0) {
        await stackRepository.delete({ id: In(stacks.map((stack) => stack.id)) });
      }

      const { id } = await stackRepository.save({
        ownerId: entity.ownerId,
        primaryAssetId: entity.assetIds[0],
        assets: [...assetIds].map((id) => ({ id }) as AssetEntity),
      });

      return stackRepository.findOneOrFail({
        where: {
          id,
        },
        relations: {
          assets: {
            exifInfo: true,
          },
        },
      });
    });
  }

  async delete(id: string): Promise<void> {
    await this.repository.delete(id);
  }

  async deleteAll(ids: string[]): Promise<void> {
    await this.repository.delete(ids);
  }

  update(entity: Partial<StackEntity>) {
    return this.save(entity);
  }

  async getById(id: string): Promise<StackEntity | null> {
    return this.repository.findOne({
      where: {
        id,
      },
      relations: {
        assets: {
          exifInfo: true,
        },
      },
      order: {
        assets: {
          fileCreatedAt: 'ASC',
        },
      },
    });
  }

  private async save(entity: Partial<StackEntity>) {
    const { id } = await this.repository.save(entity);
    return this.repository.findOneOrFail({
      where: {
        id,
      },
      relations: {
        assets: {
          exifInfo: true,
        },
      },
      order: {
        assets: {
          fileCreatedAt: 'ASC',
        },
      },
    });
  }
}
