/**
 * SQL driver — commerce: ad slots, plans, subscriptions, payments.
 *
 * Ad selection is a single indexed query per placement (`ads_placement_status_priority_idx`)
 * and honours the schedule window in SQL, so the API never has to load the whole
 * ad table to render one slot — that matters because a slot is requested on
 * every page view.
 */

import type { Connection } from '../../connection.js';
import { resolvePart, sql, type SqlPart } from '../../sql.js';
import type {
  AdRow,
  CommerceRepository,
  ID,
  List,
  PaymentRow,
  PlanRow,
  SubscriptionRow,
} from '../../ports.js';
import { PgRepo, eq, newId, pageOf, toColumns } from './helpers.js';

const AD_FIELDS = [
  'name',
  'placement',
  'type',
  'status',
  'code',
  'imageUrl',
  'linkUrl',
  'priority',
  'startsAt',
  'endsAt',
  'targeting',
] as const;

export class PgCommerceRepository extends PgRepo implements CommerceRepository {
  constructor(conn: Connection) {
    super(conn);
  }

  // ───────────────────────────────── ads ─────────────────────────────────

  async listAds(filter: { placement?: string; status?: string } = {}): Promise<AdRow[]> {
    const conds: SqlPart[] = [];
    if (filter.placement) conds.push(eq('placement', filter.placement)!);
    if (filter.status) conds.push(eq('status', filter.status)!);
    const where = resolvePart(sql.and(...conds));
    return this.conn.many<AdRow>(
      `SELECT * FROM ads WHERE ${where.text || 'TRUE'} ORDER BY placement, priority DESC, created_at DESC`,
      where.values,
    );
  }

  async adsForPlacement(placement: string, now = new Date()): Promise<AdRow[]> {
    return this.conn.many<AdRow>(
      `SELECT * FROM ads
        WHERE placement = $1 AND status = 'active'
          AND (starts_at IS NULL OR starts_at <= $2)
          AND (ends_at IS NULL OR ends_at > $2)
        ORDER BY priority DESC, created_at ASC`,
      [placement, now],
    );
  }

  async createAd(data: Partial<AdRow> & { name: string; placement: string }): Promise<AdRow> {
    const columns = toColumns(data, AD_FIELDS);
    columns.id = data.id ?? newId();
    columns.updated_at = new Date();
    if (data.targeting && !columns.targeting) columns.targeting = JSON.stringify(data.targeting);
    return this.insert<AdRow>('ads', columns);
  }

  async updateAd(id: ID, patch: Partial<AdRow>): Promise<AdRow | null> {
    const columns = toColumns(patch, [...AD_FIELDS, 'status', 'impressions', 'clicks']);
    if (patch.targeting) columns.targeting = JSON.stringify(patch.targeting);
    if (Object.keys(columns).length > 0) {
      columns.updated_at = new Date();
      await this.update('ads', 'id', id, columns);
    }
    return this.conn.one<AdRow>(`SELECT * FROM ads WHERE id = $1`, [id]);
  }

  async deleteAd(id: ID): Promise<boolean> {
    return (await this.conn.run(`DELETE FROM ads WHERE id = $1`, [id])) > 0;
  }

  async trackAd(id: ID, event: 'impression' | 'click'): Promise<void> {
    const column = event === 'click' ? 'clicks' : 'impressions';
    // Fire-and-forget counter: no transaction with the page render, because an
    // ad impression must never be able to slow down or fail a page view.
    await this.conn.run(`UPDATE ads SET ${column} = ${column} + 1 WHERE id = $1`, [id]);
  }

  // ──────────────────────────────── plans ────────────────────────────────

  async listPlans(options: { activeOnly?: boolean } = {}): Promise<PlanRow[]> {
    return this.conn.many<PlanRow>(
      `SELECT * FROM plans ${options.activeOnly ? 'WHERE is_active = true' : ''} ORDER BY sort_order, price_cents`,
    );
  }

  async findPlanBySlug(slug: string): Promise<PlanRow | null> {
    return this.conn.one<PlanRow>(`SELECT * FROM plans WHERE slug = $1`, [slug]);
  }

  async createPlan(data: Partial<PlanRow> & { slug: string; name: string; priceCents: number }): Promise<PlanRow> {
    const columns = toColumns(data, [
      'slug',
      'name',
      'description',
      'priceCents',
      'currency',
      'interval',
      'removesAds',
      'features',
      'stripePriceId',
      'paypalPlanId',
      'isActive',
      'sortOrder',
    ]);
    columns.id = data.id ?? newId();
    columns.updated_at = new Date();
    return this.insert<PlanRow>('plans', columns);
  }

  async updatePlan(id: ID, patch: Partial<PlanRow>): Promise<PlanRow | null> {
    await this.update('plans', 'id', id, {
      ...toColumns(patch, ['name', 'description', 'priceCents', 'currency', 'interval', 'removesAds', 'features', 'stripePriceId', 'paypalPlanId', 'isActive', 'sortOrder']),
      updated_at: new Date(),
    });
    return this.conn.one<PlanRow>(`SELECT * FROM plans WHERE id = $1`, [id]);
  }

  // ──────────────────────────── subscriptions ────────────────────────────

  async activeSubscriptionFor(userId: ID): Promise<SubscriptionRow | null> {
    return this.conn.one<SubscriptionRow>(
      `SELECT s.*, jsonb_build_object('id', p.id, 'slug', p.slug, 'name', p.name, 'priceCents', p.price_cents,
                                      'interval', p.interval, 'removesAds', p.removes_ads) AS plan
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.user_id = $1 AND s.status IN ('active', 'trialing', 'past_due')
          AND (s.current_period_end IS NULL OR s.current_period_end > now())
        ORDER BY s.created_at DESC LIMIT 1`,
      [userId],
    ).then((row) => (row ? mapSubscription(row) : null));
  }

  async isPremium(userId: ID | null): Promise<boolean> {
    if (!userId) return false;
    const sub = await this.activeSubscriptionFor(userId);
    return Boolean(sub && ['active', 'trialing'].includes(sub.status));
  }

  async upsertSubscription(data: Partial<SubscriptionRow> & { userId: ID; planId: ID }): Promise<SubscriptionRow> {
    // `provider_subscription_id` is unique and is the idempotency key for the
    // payment webhooks: Stripe retries a `checkout.session.completed` delivery
    // until it gets a 200, and a retry must update the row the first delivery
    // created rather than inserting a second subscription for the same user.
    let target = data.id;
    if (!target && data.providerSubscriptionId) {
      const byProvider = await this.conn.one<SubscriptionRow>(
        `SELECT * FROM subscriptions WHERE provider_subscription_id = $1`,
        [data.providerSubscriptionId],
      );
      target = byProvider?.id;
    }

    if (target) {
      const patched = toColumns(data, [
        'planId',
        'status',
        'provider',
        'providerSubscriptionId',
        'currentPeriodStart',
        'currentPeriodEnd',
        'cancelAtPeriodEnd',
      ]);
      patched.updated_at = new Date();
      const row = await this.update<SubscriptionRow>('subscriptions', 'id', target, patched);
      if (row) return row;
      // The row vanished between the lookup and the update (admin deleted it
      // mid-webhook): fall through to insert rather than losing the payment.
    }
    return this.insert<SubscriptionRow>('subscriptions', {
      id: target ?? newId(),
      user_id: data.userId,
      plan_id: data.planId,
      status: data.status ?? 'incomplete',
      provider: data.provider ?? 'stripe',
      provider_subscription_id: data.providerSubscriptionId ?? null,
      current_period_start: data.currentPeriodStart ?? new Date(),
      current_period_end: data.currentPeriodEnd ?? null,
      cancel_at_period_end: data.cancelAtPeriodEnd ?? false,
      updated_at: new Date(),
    });
  }

  async listSubscriptions(filter: { status?: string; page?: { page: number; perPage: number; offset: number } } = {}): Promise<List<SubscriptionRow>> {
    const conds: SqlPart[] = [];
    if (filter.status) conds.push(eq('s.status', filter.status)!);
    const where = resolvePart(sql.and(...conds));
    const p = pageOf(filter.page, 25);
    const total =
      (await this.conn.value<number>(
        `SELECT count(*)::int FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id WHERE ${where.text || 'TRUE'}`,
        where.values,
      )) ?? 0;
    const rows = await this.conn.many<SubscriptionRow>(
      `SELECT s.*, jsonb_build_object('id', pl.id, 'slug', pl.slug, 'name', pl.name, 'priceCents', pl.price_cents,
                                      'interval', pl.interval, 'removesAds', pl.removes_ads) AS plan
         FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id
        WHERE ${where.text || 'TRUE'} ORDER BY s.created_at DESC
        LIMIT $${where.values.length + 1} OFFSET $${where.values.length + 2}`,
      [...where.values, p.perPage, p.offset],
    );
    return { items: rows.map(mapSubscription), total };
  }

  async recordPayment(data: Omit<PaymentRow, 'id' | 'createdAt'>): Promise<PaymentRow> {
    const row = await this.conn.one<PaymentRow>(
      `INSERT INTO payments (user_id, subscription_id, provider, provider_payment_id, amount_cents, currency, status, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (provider_payment_id) DO UPDATE SET status = EXCLUDED.status, meta = EXCLUDED.meta
       RETURNING *`,
      [
        data.userId,
        data.subscriptionId ?? null,
        data.provider,
        data.providerPaymentId ?? null,
        data.amountCents,
        data.currency,
        data.status,
        data.meta ? JSON.stringify(data.meta) : null,
      ],
    );
    if (!row) throw new Error('recordPayment: no row returned');
    return row;
  }

  async findPaymentByProviderId(providerPaymentId: string): Promise<PaymentRow | null> {
    return this.conn.one<PaymentRow>(`SELECT * FROM payments WHERE provider_payment_id = $1`, [providerPaymentId]);
  }

  async listPayments(userId?: ID, page?: { page: number; perPage: number; offset: number }): Promise<List<PaymentRow>> {
    const p = pageOf(page, 25);
    const conds: SqlPart[] = [];
    if (userId) conds.push(eq('user_id', userId)!);
    const where = resolvePart(sql.and(...conds));
    const total = (await this.conn.value<number>(`SELECT count(*)::int FROM payments WHERE ${where.text || 'TRUE'}`, where.values)) ?? 0;
    const items = await this.conn.many<PaymentRow>(
      `SELECT * FROM payments WHERE ${where.text || 'TRUE'} ORDER BY created_at DESC LIMIT $${where.values.length + 1} OFFSET $${where.values.length + 2}`,
      [...where.values, p.perPage, p.offset],
    );
    return { items, total };
  }
}

function mapSubscription(row: SubscriptionRow & { plan?: unknown }): SubscriptionRow {
  const plan = row.plan as Record<string, unknown> | undefined;
  return {
    ...row,
    plan: plan
      ? {
          id: String(plan.id ?? ''),
          slug: String(plan.slug ?? ''),
          name: String(plan.name ?? ''),
          priceCents: Number(plan.priceCents ?? 0),
          interval: String(plan.interval ?? 'month'),
          removesAds: Boolean(plan.removesAds ?? true),
        }
      : undefined,
  };
}

