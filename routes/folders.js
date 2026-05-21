/**
 * F2.1 — Folders API
 * CRUD for video folders within a workspace.
 */
const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const { resolveWorkspace, requireRole } = require('../middleware/workspace');
const logger = require('../services/logger').child({ module: 'folders' });

router.use(authenticate);
router.use((req, res, next) => {
  if (!req.headers['x-workspace-id']) return res.status(400).json({ error: 'x-workspace-id header required' });
  resolveWorkspace(req, res, next);
});

// GET /api/folders — list all folders in workspace
router.get('/', async (req, res) => {
  try {
    const folders = await db.prepare(
      `SELECT * FROM folders WHERE workspace_id = ? ORDER BY name ASC`
    ).all(req.workspace.id);
    res.json(folders);
  } catch (err) {
    logger.error({ err }, 'list folders failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/folders — create folder
router.post('/', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { name, parent_id } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (name.trim().length > 255) return res.status(400).json({ error: 'name too long (max 255 chars)' });

    if (parent_id) {
      const parent = await db.prepare(
        `SELECT id FROM folders WHERE id = ? AND workspace_id = ?`
      ).get(parent_id, req.workspace.id);
      if (!parent) return res.status(404).json({ error: 'Parent folder not found' });
    }

    const id = uuidv4();
    await db.prepare(
      `INSERT INTO folders (id, workspace_id, name, parent_id) VALUES (?, ?, ?, ?)`
    ).run(id, req.workspace.id, name.trim(), parent_id || null);

    res.status(201).json({ id, workspace_id: req.workspace.id, name: name.trim(), parent_id: parent_id || null });
  } catch (err) {
    logger.error({ err }, 'create folder failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/folders/:id — rename or move folder
router.patch('/:id', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const folder = await db.prepare(
      `SELECT id, parent_id FROM folders WHERE id = ? AND workspace_id = ?`
    ).get(req.params.id, req.workspace.id);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });

    const { name, parent_id } = req.body;
    if (name !== undefined && !name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    if (name !== undefined && name.trim().length > 255) return res.status(400).json({ error: 'name too long (max 255 chars)' });

    // Validate and check for circular reference when moving
    let newParentId = folder.parent_id;
    if ('parent_id' in req.body) {
      if (parent_id === null) {
        newParentId = null;
      } else {
        const parent = await db.prepare(
          `SELECT id FROM folders WHERE id = ? AND workspace_id = ?`
        ).get(parent_id, req.workspace.id);
        if (!parent) return res.status(404).json({ error: 'Parent folder not found' });

        // Walk up the ancestor chain to detect cycles (scoped to workspace)
        let cursor = parent_id;
        while (cursor) {
          if (cursor === req.params.id) return res.status(400).json({ error: 'Cannot move a folder into itself or one of its descendants' });
          const ancestor = await db.prepare(`SELECT parent_id FROM folders WHERE id = ? AND workspace_id = ?`).get(cursor, req.workspace.id);
          cursor = ancestor ? ancestor.parent_id : null;
        }
        newParentId = parent_id;
      }
    }

    const newName = name ? name.trim() : null;
    await db.prepare(
      `UPDATE folders SET name = COALESCE(?, name), parent_id = ? WHERE id = ?`
    ).run(newName, newParentId, req.params.id);

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'update folder failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/folders/:id — delete folder (videos become unfoldered)
router.delete('/:id', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const folder = await db.prepare(
      `SELECT id FROM folders WHERE id = ? AND workspace_id = ?`
    ).get(req.params.id, req.workspace.id);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });

    await db.prepare(`UPDATE videos SET folder_id = NULL WHERE folder_id = ?`).run(req.params.id);
    await db.prepare(`DELETE FROM folders WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'delete folder failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
