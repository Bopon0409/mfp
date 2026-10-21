# mfp — command line and MCP server

```
npm run mfp -- info file.mfp|file.fig
npm run mfp -- render file [--node id|name] [--scale 2] [-o out.png]
npm run mfp -- mcp [file]
```

## MCP: agents read and edit MFP documents

The server runs over stdio. Tools: `open_file`, `new_file`, `info`, `get_tree`, `get_node`,
`find_nodes`, `set_properties`, `create_node`, `create_instance`, `delete_node`, `move_node`,
`render_png`, `undo`, `redo`, `save`. Edits go through the same rules as in the editor
(text size, auto layout, group bounds, component instances), and each one is an undo step.

Connect to Claude Code:

```
claude mcp add mfp -- node /path/to/mfp/apps/cli/src/main.ts mcp
```

Connect to Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "mfp": { "command": "node", "args": ["/path/to/mfp/apps/cli/src/main.ts", "mcp"] } } }
```

Requires Node 24+ (runs TypeScript directly).
