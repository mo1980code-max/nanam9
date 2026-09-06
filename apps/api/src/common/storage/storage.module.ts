/**
 * Storage is global because three unrelated feature areas need it: game uploads
 * (games module), artwork and avatars (users module), and the backup writer the
 * self-update flow will use. Making every one of them import a module for a
 * service that has no per-feature configuration is noise, and forgetting the
 * import is a runtime "Nest can't resolve dependencies" error rather than a
 * compile error — the worst place to discover it.
 */

import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service.js';

@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
