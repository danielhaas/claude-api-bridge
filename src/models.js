/**
 * GET /v1/models and GET /v1/models/:id
 *
 * Anthropic and OpenAI clients share this path, so each entry carries the
 * fields both expect (Anthropic: type/id/display_name/created_at; OpenAI:
 * object/id/created/owned_by).
 *
 * The list is static (the CLI has no model-listing command). Override it
 * with CAB_MODELS="id1,id2,...". Release dates aren't known here, so
 * created_at is the Unix epoch.
 */
const express = require('express');
const { makeAuthenticate } = require('./messages');

const router = express.Router();

const DEFAULT_MODELS = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

function modelIds() {
  const env = (process.env.CAB_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return env.length ? env : DEFAULT_MODELS;
}

/** "claude-sonnet-5-5" → "Claude Sonnet 5.5" */
function displayName(id) {
  const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)$/);
  if (!m) return id;
  return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
}

function describe(id) {
  return {
    type: 'model',
    id,
    display_name: displayName(id),
    created_at: '1970-01-01T00:00:00Z',
    object: 'model',
    created: 0,
    owned_by: 'anthropic',
  };
}

// Model listing errors in the Anthropic shape; OpenAI clients only look at the status code here.
const authenticate = makeAuthenticate((status, type, message, res) =>
  res.status(status).json({ type: 'error', error: { type, message } }));

router.get('/v1/models', authenticate, (req, res) => {
  const data = modelIds().map(describe);
  res.json({
    object: 'list',
    data,
    has_more: false,
    first_id: data.length ? data[0].id : null,
    last_id: data.length ? data[data.length - 1].id : null,
  });
});

router.get('/v1/models/:id', authenticate, (req, res) => {
  const id = req.params.id;
  if (!modelIds().includes(id)) {
    return res.status(404).json({ type: 'error', error: { type: 'not_found_error', message: `model: ${id}` } });
  }
  res.json(describe(id));
});

module.exports = { router, _internal: { displayName, modelIds } };
