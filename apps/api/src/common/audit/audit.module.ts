import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/** Global: every feature module writes audit lines, none of them should re-import it. */
@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
