function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in the environment or .env file`);
  return value;
}

function httpsUrl(value, name) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${name} must be an HTTPS URL without credentials, query, or fragment`,
    );
  }
  return value;
}

export function readConfig(env = process.env) {
  const issuers = required(env, 'JWS_ISSUERS')
    .split(',')
    .map((value) => httpsUrl(value.trim(), 'JWS_ISSUERS'));
  const port = Number(env.PORT || 8443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  if (issuers.length > 4)
    throw new Error('Configure at most four trusted JWS issuers');
  return {
    port,
    issuers,
    audience: required(env, 'JWS_AUDIENCE'),
    subject: required(env, 'JWS_SUBJECT'),
    orgId: required(env, 'CUSTOMER_ORG_ID'),
    schemaId: required(env, 'MEDIA_FORKING_SCHEMA_ID'),
    datasourceUrl: httpsUrl(required(env, 'DATASOURCE_URL'), 'DATASOURCE_URL'),
    certFile: required(env, 'TLS_CERT_FILE'),
    keyFile: required(env, 'TLS_KEY_FILE'),
  };
}
