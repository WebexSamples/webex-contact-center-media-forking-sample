import {
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
} from 'jose';

export function createVerifier(config, jwksOptions = {}) {
  const resolvers = new Map(
    config.issuers.map((issuer) => [
      issuer,
      createRemoteJWKSet(
        new URL(issuer.replace(/\/$/, '') + '/oauth2/v2/keys/verificationjwk/'),
        {
          cacheMaxAge: 60 * 60 * 1000,
          timeoutDuration: 5000,
          [customFetch]: (url, options) =>
            fetch(url, { ...options, redirect: 'error' }),
          ...jwksOptions,
        },
      ),
    ]),
  );

  return async (metadata) => {
    const values = metadata.get('authorization');
    if (
      values.length !== 1 ||
      typeof values[0] !== 'string' ||
      values[0].length > 8192
    ) {
      throw new Error('Missing or invalid authorization');
    }
    const token = values[0].replace(/^Bearer /i, '');
    const header = decodeProtectedHeader(token);
    // Check untrusted routing claims before any network request for verification keys.
    const issuer = decodeJwt(token).iss;
    if (
      header.alg !== 'RS256' ||
      typeof header.kid !== 'string' ||
      !header.kid ||
      !resolvers.has(issuer)
    ) {
      throw new Error('Untrusted issuer or signing algorithm');
    }
    const { payload } = await jwtVerify(token, resolvers.get(issuer), {
      algorithms: ['RS256'],
      issuer: config.issuers,
      audience: config.audience,
      subject: config.subject,
      requiredClaims: [
        'exp',
        'jti',
        'com.cisco.org.uuid',
        'com.cisco.datasource.url',
        'com.cisco.datasource.schema.uuid',
      ],
    });
    if (
      typeof payload.jti !== 'string' ||
      !payload.jti.trim() ||
      payload['com.cisco.org.uuid'] !== config.orgId ||
      payload['com.cisco.datasource.url'] !== config.datasourceUrl ||
      payload['com.cisco.datasource.schema.uuid'] !== config.schemaId
    ) {
      throw new Error('Token does not match this organization and data source');
    }
    return payload;
  };
}
