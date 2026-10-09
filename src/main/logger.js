'use strict';
/**
 * ============================================================================
 *  OmniDownloader — logger.js
 * ----------------------------------------------------------------------------
 *  Tiny append-to-file logger for the MAIN process.
 *
 *  Why it exists: a desktop app that dies without a trace is impossible to
 *  debug from the outside. Every unexpected error (uncaught exception,
 *  rejected promise, renderer crash, child-process failure) is written to
 *
 *      <userData>/logs/main.log
 *
 *  …and mirrored to the console when the app is started from a terminal.
 *
 *  • dependency-free (no winston/electron-log)
 *  • never throws: logging must be able to fail silently
 *  • rotates at 1 MB (main.log → main.old.log) so the file stays readable
 *  • buffers messages emitted before `init()` ran (early boot errors)
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024; // rotate once the log passes 1 MB

/** @type {string|null} absolute path of the active log file */
let file = null;
let enabled = false;
/** Messages logged before the userData folder was known. */
const early = [];

/** Human-readable rendering of anything a caller may pass in. */
function format(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'object' && value !== null) {
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }
  return String(value);
}

function write(level, args) {
  const line = `[${new Date().toISOString()}] ${level} ${args.map(format).join(' ')}`;

  if (!enabled) {
    early.push(line);
    if (early.length > 200) early.shift(); // bounded buffer
    return;
  }

  try { fs.appendFileSync(file, `${line}\n`, 'utf8'); } catch (_) { /* disk full/locked */ }
  try {
    (level === 'ERROR' || level === 'WARN' ? console.error : console.log)(line);
  } catch (_) { /* no console (windowed app) */ }
}

/**
 * Points the logger at `<userData>/logs/main.log`.
 * Safe to call more than once; safe to never call (messages stay buffered).
 *
 * @param {string} userDataPath `app.getPath('userData')`
 * @returns {string|null} the log file path
 */
function init(userDataPath) {
  try {
    const dir = path.join(userDataPath, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'main.log');

    // Keep the previous session's log around for one generation only.
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_BYTES) fs.renameSync(file, file.replace(/\.log$/, '.old.log'));
    } catch (_) { /* no log yet */ }

    enabled = true;
    if (early.length) {
      const backlog = early.splice(0, early.length);
      for (const line of backlog) {
        try { fs.appendFileSync(file, `${line}\n`, 'utf8'); } catch (_) { break; }
      }
    }
  } catch (_) {
    enabled = false; // logging stays disabled, app keeps running
  }
  return file;
}

module.exports = {
  init,
  file: () => file,
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args)
};
