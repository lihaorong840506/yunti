import { Module } from '@nestjs/common';

import { AppsMembersModule } from '@/apps-members/apps-members.module';
import { ComponentsVersionsModule } from '@/components-versions/components-versions.module';
import { GitModule } from '@/git/git.module';
import { MergeRequestModule } from '@/merge-requests/merge-requests.module';
import { PagesModule } from '@/pages/pages.module';
import { PublishChannelsModule } from '@/publish-channels/publish-channels.module';
import { PublishRecordsModule } from '@/publish-records/publish-records.module';

import { AppsResolver } from './apps.resolver';
import { AppsService } from './apps.service';

@Module({
  imports: [
    GitModule,
    AppsMembersModule,
    PagesModule,
    ComponentsVersionsModule,
    PublishChannelsModule,
    PublishRecordsModule,
    MergeRequestModule,
  ],
  providers: [AppsService, AppsResolver],
  exports: [AppsService],
})
export class AppsModule {}
