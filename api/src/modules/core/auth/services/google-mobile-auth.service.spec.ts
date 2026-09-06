import { BadRequestException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { GoogleMobileAuthService } from './google-mobile-auth.service';

const mockGetToken = jest.fn();
const mockVerifyIdToken = jest.fn();

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    getToken: mockGetToken,
    verifyIdToken: mockVerifyIdToken,
  })),
}));

/**
 * Fase 1 (orbix-mobile) — el servidor verifica el PKCE/id_token de Google
 * antes de resolver identidad, igual de estricto que `GoogleStrategy` en el
 * flujo web de redirect.
 */
function buildService(configValues: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    'googleOAuth.mobile.clientIds': { ios: 'ios-client-id', android: 'android-client-id', web: undefined },
    'googleOAuth.mobile.webClientSecret': undefined,
    // Client "servidor" contra el que se verifica un id_token del SDK nativo
    // (ver `serverClientId`): ni iOS ni Android firman el token, lo hace
    // siempre el client tipo Web. Sin él, todo el camino de `idToken` corta en
    // 503 antes de llegar a la verificación que estos casos ejercitan.
    'googleOAuth.clientId': 'web-client-id',
  };
  const config = { get: jest.fn((key: string) => (key in configValues ? configValues[key] : defaults[key])) };
  return new GoogleMobileAuthService(config as never);
}

describe('GoogleMobileAuthService', () => {
  afterEach(() => jest.clearAllMocks());

  it('rechaza con 503 si no hay client_id configurado para la plataforma', async () => {
    // Servidor sin ningún client Web registrado: es justo lo que este caso
    // ejercita, así que se anula el default.
    const service = buildService({ 'googleOAuth.clientId': undefined });

    await expect(
      service.verify({ platform: 'web', idToken: 'x' } as never),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('exige code+codeVerifier+redirectUri cuando no hay idToken', async () => {
    const service = buildService();

    await expect(
      service.verify({ platform: 'ios' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('canjea el code por un id_token y lo verifica', async () => {
    const service = buildService();
    mockGetToken.mockResolvedValue({ tokens: { id_token: 'the-id-token' } });
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-123',
        email: 'ana@example.com',
        email_verified: true,
        given_name: 'Ana',
        family_name: 'Pérez',
        picture: 'https://example.com/pic.jpg',
      }),
    });

    const profile = await service.verify({
      platform: 'ios',
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'orbix://auth/google',
    } as never);

    expect(mockGetToken).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'auth-code', codeVerifier: 'verifier', redirect_uri: 'orbix://auth/google' }),
    );
    expect(profile).toEqual({
      googleId: 'google-123',
      email: 'ana@example.com',
      emailVerified: true,
      firstName: 'Ana',
      lastName: 'Pérez',
      avatarUrl: 'https://example.com/pic.jpg',
    });
  });

  it('acepta un idToken directo sin pasar por getToken', async () => {
    const service = buildService();
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ sub: 'g-1', email: 'x@example.com', email_verified: true }),
    });

    await service.verify({ platform: 'android', idToken: 'direct-id-token' } as never);

    expect(mockGetToken).not.toHaveBeenCalled();
    expect(mockVerifyIdToken).toHaveBeenCalledWith(
      expect.objectContaining({ idToken: 'direct-id-token' }),
    );
  });

  it('rechaza si Google no puede canjear el code', async () => {
    const service = buildService();
    mockGetToken.mockRejectedValue(new Error('invalid_grant'));

    await expect(
      service.verify({ platform: 'ios', code: 'bad', codeVerifier: 'v', redirectUri: 'orbix://x' } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza si el id_token no verifica', async () => {
    const service = buildService();
    mockVerifyIdToken.mockRejectedValue(new Error('invalid signature'));

    await expect(
      service.verify({ platform: 'android', idToken: 'tampered' } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza si el payload no trae correo', async () => {
    const service = buildService();
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({ sub: 'g-1' }) });

    await expect(
      service.verify({ platform: 'android', idToken: 'no-email' } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('en plataforma web, manda client_secret si está configurado', async () => {
    const service = buildService({
      'googleOAuth.mobile.clientIds': { ios: undefined, android: undefined, web: 'web-client-id' },
      'googleOAuth.mobile.webClientSecret': 'web-secret',
    });
    mockGetToken.mockResolvedValue({ tokens: { id_token: 'id-token' } });
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ sub: 'g-1', email: 'x@example.com', email_verified: true }),
    });

    await service.verify({ platform: 'web', code: 'c', codeVerifier: 'v', redirectUri: 'https://x' } as never);

    expect(mockGetToken).toHaveBeenCalledWith(expect.objectContaining({ client_secret: 'web-secret' }));
  });
});
