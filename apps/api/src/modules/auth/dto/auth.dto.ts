/**
 * Auth DTOs.
 *
 * The limits come from @voltade/shared (LIMITS), so the API, the admin UI and the
 * registration form cannot disagree about what a valid username is. Every field
 * carries an @ApiProperty so the generated OpenAPI document is self-describing —
 * that document is the contract the Next.js app is written against.
 */

import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LIMITS, OAUTH_PROVIDERS } from '@voltade/shared';

/** Trim + lowercase emails at the boundary: `Admin@X.com ` and `admin@x.com` are
 *  the same account, and the database's functional unique index agrees. */
const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterDto {
  @ApiProperty({ example: 'player_one', minLength: LIMITS.username.min, maxLength: LIMITS.username.max })
  @IsString()
  @Length(LIMITS.username.min, LIMITS.username.max)
  // Arabic usernames are allowed; what is not allowed is whitespace, quotes and
  // look-alike separators that make @mentions and profile URLs ambiguous.
  @Matches(/^[\p{L}\p{N}_.-]+$/u, { message: 'username may contain letters, numbers, dot, underscore and dash only' })
  username!: string;

  @ApiPropertyOptional({ example: 'player@example.com', description: 'Optional: guests can play without an email' })
  @IsOptional()
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'email is not valid' })
  @MaxLength(LIMITS.email.max)
  email?: string;

  @ApiProperty({ example: 'correct horse battery', minLength: LIMITS.password.min })
  @IsString()
  @MinLength(LIMITS.password.min)
  @MaxLength(LIMITS.password.max)
  password!: string;

  @ApiPropertyOptional({ example: 'Player One' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string;

  @ApiPropertyOptional({ enum: ['ar', 'en'], default: 'ar' })
  @IsOptional()
  @Matches(/^(ar|en)$/)
  locale?: 'ar' | 'en';

  @ApiPropertyOptional({ description: 'Must be true: the terms are part of the contract' })
  @IsOptional()
  @IsBoolean()
  acceptTerms?: boolean;
}

export class LoginDto {
  @ApiProperty({ example: 'player_one', description: 'Username or email' })
  @IsString()
  @MinLength(3)
  @MaxLength(LIMITS.email.max)
  login!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(LIMITS.password.max)
  password!: string;

  @ApiPropertyOptional({ description: 'Six-digit TOTP code, required when 2FA is on' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$|^[A-Za-z0-9]{8,16}$/, { message: 'code must be 6 digits or a backup code' })
  code?: string;

  @ApiPropertyOptional({ description: 'Keep the refresh token for 30 days instead of the browser session' })
  @IsOptional()
  @IsBoolean()
  remember?: boolean;
}

export class RefreshDto {
  @ApiPropertyOptional({ description: 'Sent in the httpOnly cookie normally; body accepted for non-browser clients' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  refreshToken?: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @ApiProperty({ minLength: LIMITS.password.min })
  @IsString()
  @MinLength(LIMITS.password.min)
  @MaxLength(LIMITS.password.max)
  newPassword!: string;

  @ApiPropertyOptional({ description: 'Revoke every other session after the change (default true)' })
  @IsOptional()
  @IsBoolean()
  revokeOthers?: boolean;
}

export class TwoFactorSetupDto {
  @ApiPropertyOptional({ description: 'Account password, re-checked before enabling 2FA' })
  @IsOptional()
  @IsString()
  password?: string;
}

export class TwoFactorEnableDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}

export class TwoFactorDisableDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  password!: string;
}

export class OAuthStartQuery {
  @ApiProperty({ enum: OAUTH_PROVIDERS })
  @IsString()
  @Matches(new RegExp(`^(${OAUTH_PROVIDERS.join('|')})$`))
  provider!: string;

  @ApiPropertyOptional({ description: 'Where the portal sends the browser after sign-in' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  redirect?: string;
}

export class OAuthCallbackQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) code?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) state?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) error?: string;
}
