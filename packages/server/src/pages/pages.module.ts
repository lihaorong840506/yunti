import { Module } from '@nestjs/common';

import { AppsMembersModule } from '@/apps-members/apps-members.module';
import { GitModule } from '@/git/git.module';
import { MergeRequestModule } from '@/merge-requests/merge-requests.module';

import { PagesResolver } from './pages.resolver';
import { PagesService } from './pages.service';

@Module({
  imports: [GitModule, AppsMembersModule, MergeRequestModule],
  providers: [PagesService, PagesResolver],
  exports: [PagesService],
})
export class PagesModule {}
