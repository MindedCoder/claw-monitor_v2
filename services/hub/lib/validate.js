const { APP_ID_RE } = require('./config');

function validateAppId(appId) {
  if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) {
    const error = new Error('invalid appId (expected [a-z0-9][a-z0-9-]{1,39})');
    error.statusCode = 400;
    throw error;
  }
  return appId;
}

function validateVersion(version) {
  if (typeof version !== 'string' || version.length === 0 || version.length > 64) {
    const error = new Error('invalid version (must be 1-64 chars)');
    error.statusCode = 400;
    throw error;
  }
  if (version.includes('/') || version.includes('\\') || version.includes('..')) {
    const error = new Error('invalid version (forbidden chars: / \\ ..)');
    error.statusCode = 400;
    throw error;
  }
  return version;
}

function validateFilename(filename) {
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > 255) {
    const error = new Error('invalid filename');
    error.statusCode = 400;
    throw error;
  }
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    const error = new Error('invalid filename (forbidden chars: / \\ ..)');
    error.statusCode = 400;
    throw error;
  }
  return filename;
}

function validateSize(size) {
  if (!Number.isInteger(size) || size <= 0 || size > 10 * 1024 * 1024 * 1024) {
    const error = new Error('invalid size (1 byte to 10 GiB)');
    error.statusCode = 400;
    throw error;
  }
  return size;
}

function validateSha256(sha256) {
  if (sha256 == null || sha256 === '') return null;
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)) {
    const error = new Error('invalid sha256 (expected 64 hex chars)');
    error.statusCode = 400;
    throw error;
  }
  return sha256.toLowerCase();
}

function validateInstructions(instructions) {
  if (instructions == null || instructions === '') return '';
  if (typeof instructions !== 'string' || instructions.length > 4000) {
    const error = new Error('invalid instructions (max 4000 chars)');
    error.statusCode = 400;
    throw error;
  }
  return instructions;
}

function validateChunkSize(chunkSize) {
  if (
    !Number.isInteger(chunkSize) ||
    chunkSize < 64 * 1024 ||
    chunkSize > 100 * 1024 * 1024
  ) {
    const error = new Error('invalid chunkSize (64 KiB to 100 MiB)');
    error.statusCode = 400;
    throw error;
  }
  return chunkSize;
}

module.exports = {
  validateAppId,
  validateVersion,
  validateFilename,
  validateSize,
  validateSha256,
  validateChunkSize,
  validateInstructions,
};
