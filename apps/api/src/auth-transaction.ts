import type { FastifyRequest } from 'fastify';
import type { Actor } from '@hostline/contracts';
import type { Database, TenantTransaction } from '@hostline/database';
import { AuthError, type AuthService } from './auth.js';

/** Recheck durable authority and hold it through the tenant's local transaction. */
export function withStaffTenant<T>(
  auth: AuthService,
  db: Database,
  mode: 'demo' | 'oidc',
  request: FastifyRequest,
  actor: Actor,
  work: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  const binding = auth.databaseBinding(request);
  if (binding) {
    return db.withAuthenticatedTenant(binding, async (tx, session) => {
      if (
        session.tenantId !== actor.tenantId ||
        session.identityId !== actor.userId ||
        session.role !== actor.role
      )
        throw new AuthError('UNAUTHENTICATED', 401, 'Sign in to continue.');
      return work(tx);
    });
  }
  if (mode !== 'demo') throw new AuthError('UNAUTHENTICATED', 401, 'Sign in to continue.');
  return db.withTenant(actor.tenantId, work);
}
