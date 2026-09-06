/**
 * SQL driver — identity: users, sessions, OAuth links, roles & permissions.
 *
 * Passwords are never selected by default (`safeUser`), tokens are stored
 * hashed, and the permission catalogue is written idempotently by `syncRbac` so
 * a deploy that adds a permission does not need a manual SQL step.
 */

import type { Connection } from '../../connection.js';
import { resolvePart, sql, type SqlPart } from '../../sql.js';
import type {
  ID,
  IdentityRepository,
  List,
  OAuthAccountRow,
  PermissionRow,
  RoleRow,
  SessionRow,
  UserListFilter,
  UserRow,
} from '../../ports.js';
import { PgRepo, eq, likeAny, newId, pageOf, toColumns } from './helpers.js';

const USER_FIELDS = [
  'email',
  'username',
  'displayName',
  'avatarUrl',
  'passwordHash',
  'locale',
  'timezone',
  'bio',
  'website',
  'status',
  'roleId',
  'xp',
  'level',
  'playsCount',
  'commentsCount',
  'twoFactorSecret',
  'twoFactorEnabled',
  'twoFactorBackupCodes',
  'emailVerifiedAt',
  'lastLoginAt',
  'lastLoginIp',
  'deletedAt',
] as const;

/** Everything except `password_hash`, which no API response ever needs. */
const USER_SELECT = `
  SELECT u.id, u.email, u.username, u.display_name, u.avatar_url, u.locale, u.timezone, u.bio, u.website,
         u.status, u.role_id, u.xp, u.level, u.plays_count, u.comments_count,
         u.two_factor_enabled, u.email_verified_at, u.last_login_at, u.last_login_ip,
         u.created_at, u.updated_at, u.deleted_at,
         r.slug AS "roleSlug", r.name AS "roleName", r.level AS "roleLevel"
    FROM users u JOIN roles r ON r.id = u.role_id`;

export class PgIdentityRepository extends PgRepo implements IdentityRepository {
  constructor(conn: Connection) {
    super(conn);
  }

  // ─────────────────────────────── users ───────────────────────────────

  async findUserById(id: ID, withRole = true): Promise<UserRow | null> {
    const row = withRole
      ? await this.conn.one<UserRow & { roleSlug: string; roleName: string; roleLevel: number }>(`${USER_SELECT} WHERE u.id = $1`, [id])
      : await this.conn.one<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
    return row ? mapUser(row) : null;
  }

  async findUserByLogin(login: string): Promise<UserRow | null> {
    return (await this.findUserByEmail(login)) ?? (await this.findUserByUsername(login));
  }

  async findUserByEmail(email: string): Promise<UserRow | null> {
    // lower() on both sides: the functional unique index in migration 0002 is
    // what makes "Admin@x" and "admin@x" the same account.
    const row = await this.conn.one<UserRow & { roleSlug: string; roleName: string; roleLevel: number }>(
      `${USER_SELECT} WHERE lower(u.email) = lower($1)`,
      [email],
    );
    return row ? mapUser(row) : null;
  }

  async findUserByUsername(username: string): Promise<UserRow | null> {
    const row = await this.conn.one<UserRow & { roleSlug: string; roleName: string; roleLevel: number }>(
      `${USER_SELECT} WHERE lower(u.username) = lower($1)`,
      [username],
    );
    return row ? mapUser(row) : null;
  }

  /** Selects the password hash. Auth only — never returned to a controller. */
  async findUserCredentials(login: string): Promise<(UserRow & { passwordHash: string | null }) | null> {
    const row = await this.conn.one<UserRow & { passwordHash: string | null }>(
      `SELECT u.*, r.slug AS "roleSlug", r.name AS "roleName", r.level AS "roleLevel"
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE lower(u.email) = lower($1) OR lower(u.username) = lower($1)`,
      [login],
    );
    return row ? mapUser(row) : null;
  }

  async createUser(data: Partial<UserRow> & { username: string; roleId: ID }): Promise<UserRow> {
    const columns = toColumns(data, USER_FIELDS);
    columns.id = data.id ?? newId();
    columns.updated_at = new Date();
    columns.locale ??= 'ar';
    columns.status ??= 'active';
    const row = await this.insert<UserRow>('users', columns);
    return (await this.findUserById(row.id)) ?? row;
  }

  async updateUser(id: ID, patch: Partial<UserRow>): Promise<UserRow | null> {
    const columns = toColumns(patch, USER_FIELDS);
    if (Object.keys(columns).length > 0) {
      columns.updated_at = new Date();
      await this.update('users', 'id', id, columns);
    }
    return this.findUserById(id);
  }

  async deleteUser(id: ID, options: { hard?: boolean; ban?: boolean } = {}): Promise<boolean> {
    if (options.hard) return (await this.conn.run(`DELETE FROM users WHERE id = $1`, [id])) > 0;
    const status = options.ban ? 'banned' : 'deleted';
    return (await this.conn.run(`UPDATE users SET status = $2, deleted_at = now() WHERE id = $1`, [id, status])) > 0;
  }

  async listUsers(filter: UserListFilter = {}): Promise<List<UserRow>> {
    const conds: SqlPart[] = [sql`u.deleted_at IS NULL`];
    const like = likeAny(['u.username', 'u.email', 'u.display_name'], filter.q);
    if (like) conds.push(like);
    if (filter.status) conds.push(eq('u.status', filter.status)!);
    if (filter.roleSlug) conds.push(eq('r.slug', filter.roleSlug)!);
    const where = resolvePart(sql.and(...conds));
    const p = pageOf(filter.page, 25);
    const orderBy =
      filter.sort === 'xp'
        ? 'u.xp DESC'
        : filter.sort === 'plays'
          ? 'u.plays_count DESC'
          : filter.sort === 'username'
            ? 'u.username ASC'
            : 'u.created_at DESC';

    const total = (await this.conn.value<number>(
      `SELECT count(*)::int FROM users u JOIN roles r ON r.id = u.role_id WHERE ${where.text}`,
      where.values,
    )) ?? 0;
    const rows = await this.conn.many<UserRow & { roleSlug: string; roleName: string; roleLevel: number }>(
      `SELECT u.*, r.slug AS "roleSlug", r.name AS "roleName", r.level AS "roleLevel"
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE ${where.text} ORDER BY ${orderBy} LIMIT $${where.values.length + 1} OFFSET $${where.values.length + 2}`,
      [...where.values, p.perPage, p.offset],
    );
    return { items: rows.map(mapUser), total };
  }

  async countUsers(): Promise<number> {
    return (await this.conn.value<number>(`SELECT count(*)::int FROM users WHERE deleted_at IS NULL`)) ?? 0;
  }

  async touchLogin(id: ID, ip: string | null): Promise<void> {
    await this.conn.run(`UPDATE users SET last_login_at = now(), last_login_ip = $2 WHERE id = $1`, [id, ip]);
  }

  // ────────────────────────────── sessions ──────────────────────────────

  async createSession(data: {
    userId: ID;
    tokenHash: string;
    kind?: string;
    userAgent?: string | null;
    ip?: string | null;
    expiresAt: Date;
  }): Promise<SessionRow> {
    return this.insert<SessionRow>('sessions', {
      id: newId(),
      user_id: data.userId,
      token_hash: data.tokenHash,
      kind: data.kind ?? 'refresh',
      user_agent: data.userAgent ?? null,
      ip: data.ip ?? null,
      expires_at: data.expiresAt,
    });
  }

  async findSessionByHash(tokenHash: string): Promise<SessionRow | null> {
    return this.conn.one<SessionRow>(
      `SELECT * FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [tokenHash],
    );
  }

  async touchSession(id: ID): Promise<void> {
    await this.conn.run(`UPDATE sessions SET last_used_at = now() WHERE id = $1`, [id]);
  }

  async revokeSession(id: ID): Promise<boolean> {
    return (await this.conn.run(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [id])) > 0;
  }

  async revokeSessionsForUser(userId: ID, exceptId?: ID): Promise<number> {
    return this.conn.run(
      `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL ${exceptId ? 'AND id <> $2' : ''}`,
      exceptId ? [userId, exceptId] : [userId],
    );
  }

  async listSessions(userId: ID): Promise<SessionRow[]> {
    return this.conn.many<SessionRow>(
      `SELECT * FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
      [userId],
    );
  }

  async deleteExpiredSessions(): Promise<number> {
    return this.conn.run(`DELETE FROM sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '30 days'`);
  }

  // ─────────────────────────────── oauth ───────────────────────────────

  async findOAuthAccount(provider: string, providerUserId: string): Promise<OAuthAccountRow | null> {
    return this.conn.one<OAuthAccountRow>(`SELECT * FROM oauth_accounts WHERE provider = $1 AND provider_user_id = $2`, [
      provider,
      providerUserId,
    ]);
  }

  async findOAuthAccountsForUser(userId: ID): Promise<OAuthAccountRow[]> {
    return this.conn.many<OAuthAccountRow>(`SELECT * FROM oauth_accounts WHERE user_id = $1 ORDER BY provider`, [userId]);
  }

  async deleteOAuthAccount(id: ID): Promise<boolean> {
    return (await this.conn.run(`DELETE FROM oauth_accounts WHERE id = $1`, [id])) > 0;
  }

  async upsertOAuthAccount(
    data: Omit<OAuthAccountRow, 'id' | 'createdAt'> & { accessToken?: string | null; refreshToken?: string | null },
  ): Promise<OAuthAccountRow> {
    const row = await this.conn.one<OAuthAccountRow>(
      `INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, email, name, avatar_url, access_token, refresh_token, token_expires_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       ON CONFLICT (provider, provider_user_id) DO UPDATE
         SET user_id = EXCLUDED.user_id, email = EXCLUDED.email, name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url,
             access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token,
             token_expires_at = EXCLUDED.token_expires_at, updated_at = now()
       RETURNING *`,
      [
        newId(),
        data.userId,
        data.provider,
        data.providerUserId,
        data.email ?? null,
        data.name ?? null,
        data.avatarUrl ?? null,
        data.accessToken ?? null,
        data.refreshToken ?? null,
        data.tokenExpiresAt ?? null,
      ],
    );
    if (!row) throw new Error('upsertOAuthAccount: no row returned');
    return row;
  }

  // ─────────────────────────── roles & permissions ───────────────────────────

  async listRoles(): Promise<RoleRow[]> {
    return this.conn.many<RoleRow>(`SELECT * FROM roles ORDER BY level DESC, slug`);
  }

  async findRoleBySlug(slug: string): Promise<RoleRow | null> {
    return this.conn.one<RoleRow>(`SELECT * FROM roles WHERE slug = $1`, [slug]);
  }

  async listPermissions(): Promise<PermissionRow[]> {
    return this.conn.many<PermissionRow>(`SELECT * FROM permissions ORDER BY module, action`);
  }

  async permissionsForRoleIds(roleIds: ID[]): Promise<string[]> {
    if (roleIds.length === 0) return [];
    const rows = await this.conn.many<{ slug: string }>(
      `SELECT DISTINCT p.slug FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = ANY($1) ORDER BY p.slug`,
      [roleIds],
    );
    return rows.map((r) => r.slug);
  }

  async syncRbac(catalogue: {
    permissions: { slug: string; module: string; action: string }[];
    roles: { slug: string; name: string; level: number; permissions: string[] }[];
  }): Promise<void> {
    await this.conn.tx(async (tx) => {
      for (const p of catalogue.permissions) {
        await tx.run(
          `INSERT INTO permissions (id, slug, module, action)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (slug) DO UPDATE SET module = EXCLUDED.module, action = EXCLUDED.action`,
          [newId(), p.slug, p.module, p.action],
        );
      }
      for (const r of catalogue.roles) {
        const role = await tx.one<RoleRow>(
          `INSERT INTO roles (id, slug, name, level, is_system, updated_at)
           VALUES ($1,$2,$3,$4,true,now())
           ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, level = EXCLUDED.level, updated_at = now()
           RETURNING *`,
          [newId(), r.slug, r.name, r.level],
        );
        if (!role) continue;
        await tx.run(`DELETE FROM role_permissions WHERE role_id = $1`, [role.id]);
        // '*' means every permission, present and future — expanded at write time
        // so the guard never has to special-case it on the read path.
        const slugs = r.permissions.includes('*') ? catalogue.permissions.map((p) => p.slug) : r.permissions;
        if (slugs.length === 0) continue;
        await tx.run(
          `INSERT INTO role_permissions (role_id, permission_id)
           SELECT $1, id FROM permissions WHERE slug = ANY($2)
           ON CONFLICT DO NOTHING`,
          [role.id, slugs],
        );
      }
    });
  }
}

function mapUser(row: UserRow & { roleSlug?: string; roleName?: string; roleLevel?: number }): UserRow {
  const { roleSlug, roleName, roleLevel, ...rest } = row as UserRow & {
    roleSlug?: string;
    roleName?: string;
    roleLevel?: number;
  };
  if (!roleSlug) return rest as UserRow;
  return {
    ...(rest as UserRow),
    role: { id: (rest as UserRow).roleId, slug: roleSlug, name: roleName ?? roleSlug, level: roleLevel ?? 20 },
  };
}

