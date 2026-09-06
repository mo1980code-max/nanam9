/**
 * /api/auth — the only place in the product that creates or destroys a session.
 *
 * Every response is the standard envelope; the cookies are the real payload. The
 * frontend never stores a token in localStorage (an XSS would own the account):
 * it reads `voltade_csrf`, sends it back as a header, and lets the browser carry
 * the httpOnly cookies.
 */

import { Body, Controller, Delete, Get, Inject, Param, Post, Query, Req, Res, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { COOKIES } from '@voltade/shared';
import { AuthService } from './auth.service.js';
import { OauthService, OAUTH_STATE_COOKIE } from './oauth.service.js';
import { cookieOptions } from './token.service.js';
import {
  ChangePasswordDto,
  LoginDto,
  OAuthCallbackQuery,
  OAuthStartQuery,
  RefreshDto,
  RegisterDto,
  TwoFactorDisableDto,
  TwoFactorEnableDto,
} from './dto/auth.dto.js';
import { ClientIp, CurrentUser, Permissions, Public, RateLimit, Roles, type AuthenticatedRequest, type RequestUser } from '../../common/decorators/index.js';
import { AppError, UnauthorizedError, ValidationError } from '../../common/http/errors.js';
import { CONFIG, type AppConfig } from '../../config/env.js';
type Meta = { ip?: string | null; userAgent?: string | null };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly oauth: OauthService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // ────────────────────────────── sign up / in ──────────────────────────────

  @Public()
  @RateLimit('auth')
  @Post('register')
  @ApiOperation({ summary: 'Create an account and sign the caller in' })
  @ApiResponse({ status: 201, description: 'Account created; session cookies set' })
  @ApiResponse({ status: 409, description: 'Username or email already taken' })
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response, @ClientIp() ip: string) {
    const result = await this.auth.register(dto, this.meta(req, ip));
    this.setSessionCookies(res, result.session.accessToken, result.refreshToken, true);
    return { user: result.user, expiresAt: result.session.expiresAt };
  }

  @Public()
  @RateLimit('login')
  @Post('login')
  @HttpCode(HttpStatus.OK) // this route creates no resource; 201 would be a lie
  @ApiOperation({ summary: 'Sign in with a username/email and password' })
  @ApiResponse({ status: 200, description: 'Signed in, or a 2FA challenge was issued' })
  @ApiResponse({ status: 401, description: 'Wrong credentials' })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response, @ClientIp() ip: string) {
    const result = await this.auth.login(dto, this.meta(req, ip));
    if (result.twoFactorRequired) {
      // No cookies yet: the session starts only after the code is accepted.
      return result;
    }
    this.setSessionCookies(res, result.session.accessToken, result.refreshToken, true);
    return { user: result.user, expiresAt: result.session.expiresAt };
  }

  @Public()
  @RateLimit('login')
  @Post('2fa/verify')
  @HttpCode(HttpStatus.OK) // this route creates no resource; 201 would be a lie
  @ApiOperation({ summary: 'Finish a sign-in that asked for a two-factor code' })
  async verifyTwoFactor(
    @Body() body: { challengeToken?: string; code?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @ClientIp() ip: string,
  ) {
    if (!body.challengeToken || !body.code) throw new ValidationError({ challengeToken: ['required'], code: ['required'] });
    const result = await this.auth.completeTwoFactor(body.challengeToken, body.code, this.meta(req, ip));
    this.setSessionCookies(res, result.session.accessToken, result.refreshToken, true);
    return { user: result.user, expiresAt: result.session.expiresAt };
  }

  @Public()
  @RateLimit('auth')
  @Post('refresh')
  @HttpCode(HttpStatus.OK) // this route creates no resource; 201 would be a lie
  @ApiOperation({ summary: 'Exchange the refresh cookie for a new access token (rotating)' })
  async refresh(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response, @ClientIp() ip: string) {
    const refreshToken = dto.refreshToken ?? (req.cookies?.[COOKIES.refreshToken] as string | undefined);
    if (!refreshToken) throw new UnauthorizedError('no refresh token', 'auth.invalid_token');
    const result = await this.auth.refresh(refreshToken, this.meta(req, ip));
    this.setSessionCookies(res, result.session.accessToken, result.refreshToken, true);
    return { user: result.session.user, expiresAt: result.session.expiresAt };
  }

  @Post('logout')

  @HttpCode(HttpStatus.OK) // this route creates no resource; 201 would be a lie
  @RateLimit('auth')
  @ApiOperation({ summary: 'Revoke the refresh token and clear the session cookies' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response, @CurrentUser() user: RequestUser | null, @ClientIp() ip: string) {
    const refreshToken = req.cookies?.[COOKIES.refreshToken] as string | undefined;
    const result = await this.auth.logout(refreshToken, user, this.meta(req, ip));
    this.clearSessionCookies(res);
    return result;
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The signed-in user, with role, permissions and premium state' })
  async me(@CurrentUser() user: RequestUser) {
    if (!user) throw new UnauthorizedError();
    return this.auth.me(user);
  }

  // ──────────────────────────────── account ────────────────────────────────

  @Post('password')

  @HttpCode(HttpStatus.OK) // this route creates no resource; 201 would be a lie
  @RateLimit('auth')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change the password and (by default) sign out other devices' })
  async changePassword(@Body() dto: ChangePasswordDto, @CurrentUser() user: RequestUser, @Req() req: Request, @ClientIp() ip: string) {
    if (!user) throw new UnauthorizedError();
    return this.auth.changePassword(user, dto, this.meta(req, ip));
  }

  @Get('sessions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Active sessions for this account (device, IP, last used)' })
  async sessions(@CurrentUser() user: RequestUser) {
    if (!user) throw new UnauthorizedError();
    return this.auth.listSessions(user);
  }

  @Delete('sessions/:id')
  @RateLimit('write')
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'Session id from GET /auth/sessions' })
  async revokeSession(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    if (!user) throw new UnauthorizedError();
    return this.auth.revokeSession(user, id);
  }

  @Delete('sessions')
  @RateLimit('write')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign out everywhere except this device' })
  async revokeAll(@CurrentUser() user: RequestUser) {
    if (!user) throw new UnauthorizedError();
    return this.auth.revokeEverywhere(user);
  }

  // ───────────────────────────────── 2FA ─────────────────────────────────

  @Get('2fa/setup')
  @RateLimit('auth')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start enabling 2FA: secret, otpauth URL, QR and one-time backup codes' })
  async setupTwoFactor(@CurrentUser() user: RequestUser) {
    if (!user) throw new UnauthorizedError();
    return this.auth.setupTwoFactor(user);
  }

  @Post('2fa/enable')

  @HttpCode(HttpStatus.OK) // this route creates no resource; 201 would be a lie
  @RateLimit('auth')
  @ApiBearerAuth()
  async enableTwoFactor(@Body() dto: TwoFactorEnableDto, @CurrentUser() user: RequestUser) {
    if (!user) throw new UnauthorizedError();
    return this.auth.enableTwoFactor(user, dto.code);
  }

  @Post('2fa/disable')

  @HttpCode(HttpStatus.OK) // this route creates no resource; 201 would be a lie
  @RateLimit('auth')
  @ApiBearerAuth()
  async disableTwoFactor(@Body() dto: TwoFactorDisableDto, @CurrentUser() user: RequestUser) {
    if (!user) throw new UnauthorizedError();
    return this.auth.disableTwoFactor(user, dto.password);
  }

  // ───────────────────────────────── OAuth ─────────────────────────────────

  @Public()
  @Get('oauth/providers')
  @ApiOperation({ summary: 'Which social providers are configured (the UI hides the rest)' })
  providers() {
    return this.oauth.listEnabled();
  }

  @Public()
  @RateLimit('auth')
  @Get('oauth/:provider')
  @ApiParam({ name: 'provider', enum: ['google', 'facebook', 'discord'] })
  @ApiOperation({ summary: 'Redirect the browser to the provider' })
  async startOAuth(
    @Param('provider') provider: string,
    @Query() query: OAuthStartQuery,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    const redirectUri = this.callbackUrl(req, provider);
    const { url, state } = this.oauth.buildAuthorizeUrl(provider, redirectUri, query.redirect);
    // The state cookie is httpOnly and short-lived: it is the CSRF token of the
    // OAuth flow, so a forged callback cannot sign an attacker's account in here.
    res.cookie(OAUTH_STATE_COOKIE, `${provider}:${state}:${encodeURIComponent(query.redirect ?? '/me')}`, {
      httpOnly: true,
      secure: this.config.COOKIE_SECURE || this.config.isProduction,
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000,
      path: '/',
    });
    res.redirect(302, url);
  }

  @Public()
  @RateLimit('auth')
  @Get('oauth/:provider/callback')
  @ApiOperation({ summary: 'Provider redirect target: verifies state, issues our own session' })
  async oauthCallback(
    @Param('provider') provider: string,
    @Query() query: OAuthCallbackQuery,
    @Req() req: Request,
    @Res() res: Response,
    @ClientIp() ip: string,
  ) {
    const returnTo = this.verifyState(req, provider, query.state);
    if (query.error || !query.code) {
      return res.redirect(302, `/login?error=${encodeURIComponent(query.error ?? 'oauth_failed')}`);
    }

    try {
      const result = await this.oauth.handleCallback(provider, query.code, this.callbackUrl(req, provider), this.meta(req, ip));
      this.setSessionCookies(res, result.tokens.accessToken, result.tokens.refreshToken, true);
      return res.redirect(302, `${returnTo}?oauth=${result.isNew ? 'registered' : 'signed_in'}`);
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'oauth.failed';
      this.loggerWarn(`${provider} callback failed: ${error instanceof Error ? error.message : String(error)}`);
      return res.redirect(302, `/login?error=${encodeURIComponent(code)}`);
    }
  }

  @Public()
  @Get('oauth/dev/consent')
  @ApiOperation({ summary: 'DEV ONLY: local account chooser standing in for Google consent' })
  devConsent(@Query('provider') provider: string, @Query('state') state: string, @Res() res: Response) {
    if (!this.oauth.devMode(provider) || !state) {
      return res.status(404).type('text/plain; charset=utf-8').send('not available');
    }
    const accounts = [
      { email: 'player.voltade@gmail.com', name: 'لاعب فولتيد' },
      { email: 'sara.plays@gmail.com', name: 'سارة تلعب' },
      { email: 'champ.ar@gmail.com', name: 'بطل العرب' },
    ];
    const action = `/auth/oauth/dev/approve?provider=${encodeURIComponent(provider)}&state=${encodeURIComponent(state)}`;
    const rows = accounts
      .map(
        (a) =>
          `<form method="get" action="${action}"><input type="hidden" name="email" value="${a.email}"><input type="hidden" name="name" value="${a.name}"><button type="submit"><span class="av">${a.name.charAt(0)}</span><span class="meta"><b>${a.name}</b><i dir="ltr">${a.email}</i></span></button></form>`,
      )
      .join('');
    res.type('text/html; charset=utf-8').send(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>اختيار حساب Google — وضع تجريبي</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b12;font-family:system-ui,'Segoe UI',sans-serif;color:#e8e8f2}main{width:min(420px,92vw);background:#141422;border:1px solid #26263a;border-radius:18px;padding:26px}h1{font-size:18px;margin:0 0 4px}p{font-size:12px;color:#9a9ab0;margin:0 0 18px}form button{width:100%;display:flex;align-items:center;gap:12px;background:#1c1c2e;border:1px solid #2c2c44;border-radius:14px;padding:12px;margin-bottom:10px;color:inherit;font:inherit;cursor:pointer;text-align:start}.av{width:38px;height:38px;border-radius:50%;background:#7c3aed;display:grid;place-items:center;font-weight:800}.meta{display:grid}.meta i{font-style:normal;color:#9a9ab0;font-size:12px}input[type=text],input[type=email]{width:100%;box-sizing:border-box;background:#1c1c2e;border:1px solid #2c2c44;border-radius:10px;padding:10px;color:inherit;font:inherit;margin-bottom:8px}.go{width:100%;background:#7c3aed;border:0;border-radius:12px;padding:12px;color:#fff;font:inherit;font-weight:800;cursor:pointer}.tag{display:inline-block;background:#7c3aed22;color:#a78bfa;border-radius:99px;padding:3px 10px;font-size:11px;font-weight:700;margin-bottom:12px}</style></head><body><main><span class="tag">وضع تجريبي — لا يُعرض في الإنتاج</span><h1>اختيار حساب للمتابعة إلى Voltade</h1><p>هذه شاشة موافقة محلية تحل محل Google لأن مفاتيح OAuth غير مضبوطة في هذه البيئة.</p>${rows}<form method="get" action="${action}"><input type="text" name="name" placeholder="الاسم الظاهر (اختياري)"><input type="email" name="email" placeholder="بريدك@gmail.com" required><button class="go" type="submit">المتابعة بحساب آخر</button></form></main></body></html>`);
  }

  @Public()
  @RateLimit('auth')
  @Get('oauth/dev/approve')
  @ApiOperation({ summary: 'DEV ONLY: completes the local consent as a real session' })
  async devApprove(
    @Query('provider') provider: string,
    @Query('state') state: string,
    @Query('email') email: string,
    @Query('name') name: string,
    @Req() req: Request,
    @Res() res: Response,
    @ClientIp() ip: string,
  ) {
    let returnTo = '/';
    try {
      returnTo = this.verifyState(req, provider, state);
    } catch {
      return res.redirect(302, `/login?error=${encodeURIComponent('oauth.state_mismatch')}`);
    }
    try {
      const result = await this.oauth.devApprove(provider, { email: email ?? '', name: name ?? '' }, this.meta(req, ip));
      this.setSessionCookies(res, result.tokens.accessToken, result.tokens.refreshToken, true);
      return res.redirect(302, `${returnTo}?oauth=${result.isNew ? 'registered' : 'signed_in'}`);
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'oauth.failed';
      return res.redirect(302, `/login?error=${encodeURIComponent(code)}`);
    }
  }

  @Delete('oauth/:provider')
  @RateLimit('write')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Unlink a provider (refused if it is the last way to sign in)' })
  async unlink(@Param('provider') provider: string, @CurrentUser() user: RequestUser) {
    if (!user) throw new UnauthorizedError();
    return this.oauth.unlink({ id: user.id, username: user.username }, provider);
  }

  // ─────────────────────────────── impersonation ───────────────────────────────

  @Post('impersonate/:userId')

  @HttpCode(HttpStatus.OK) // this route creates no resource; 201 would be a lie
  @Roles('super-admin')
  @Permissions('users.impersonate')
  @RateLimit('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign in as another user to reproduce a support report (audited)' })
  async impersonate(
    @Param('userId') userId: string,
    @CurrentUser() user: RequestUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @ClientIp() ip: string,
  ) {
    if (!user) throw new UnauthorizedError();
    const result = await this.auth.impersonate(user, userId, this.meta(req, ip));
    this.setSessionCookies(res, result.session.accessToken, result.refreshToken, true);
    return { user: result.user, impersonatedBy: user.username };
  }

  // ───────────────────────────────── helpers ─────────────────────────────────

  private loggerWarn(message: string): void {
    // A controller does not own a Logger; the exception filter logs 5xx. This is
    // for the OAuth redirect path, which never reaches the filter.
    if (!this.config.isProduction) console.warn(message);
  }

  private meta(req: Request, ip: string): Meta {
    return { ip, userAgent: (req.headers['user-agent'] as string | undefined) ?? null };
  }

  private callbackUrl(req: Request, provider: string): string {
    // Behind a proxy the public origin is in x-forwarded-*; falling back to the
    // configured APP_URL keeps generated links absolute (OAuth requires it).
    const forwardedHost = req.headers['x-forwarded-host'];
    const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? req.headers.host;
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? (req.secure ? 'https' : 'http');
    const base = host && this.config.isProduction ? `${proto}://${host}` : this.config.APP_URL.replace(/\/$/, '');
    return `${base.replace(/\/$/, '')}/api/auth/oauth/${provider}/callback`;
  }

  private verifyState(req: Request, provider: string, state?: string): string {
    const raw = req.cookies?.[OAUTH_STATE_COOKIE] as string | undefined;
    if (!raw || !state) throw new AppError('oauth.state_missing', 'the sign-in attempt expired — start again', 400);
    const [cookieProvider, cookieState, returnTo] = raw.split(':');
    if (cookieProvider !== provider || cookieState !== state) {
      throw new AppError('oauth.state_mismatch', 'the sign-in attempt did not originate from this site', 400);
    }
    const target = decodeURIComponent(returnTo ?? '/me');
    // Only same-site paths: an attacker-supplied `https://evil.tld` in returnTo
    // would turn our sign-in into an open redirect.
    return target.startsWith('/') && !target.startsWith('//') ? target : '/me';
  }

  private setSessionCookies(res: Response, accessToken: string, refreshToken: string | null, remember: boolean): void {
    const policy = this.auth.cookiePolicy();
    res.cookie(policy.access.name, accessToken, cookieOptions(this.config, { maxAgeSeconds: policy.access.maxAgeSeconds }));
    res.cookie(
      policy.refresh.name,
      refreshToken ?? '',
      cookieOptions(this.config, {
        // "Remember me" is a maxAge; without it the refresh token dies with the tab.
        maxAgeSeconds: remember ? policy.refresh.maxAgeSeconds : undefined,
      }),
    );
  }

  private clearSessionCookies(res: Response): void {
    const policy = this.auth.cookiePolicy();
    for (const name of [policy.access.name, policy.refresh.name]) {
      res.clearCookie(name, cookieOptions(this.config, {}));
    }
  }

}
