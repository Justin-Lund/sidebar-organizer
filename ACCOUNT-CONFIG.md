# Account configuration

An opt-in layout is stored in Home Assistant's authenticated frontend user data,
under `sidebar_organizer`, as `{ "version": 1, "config": { ... } }`.
The backend selects the authenticated user's ID; no user ID or name is accepted
from configuration. This is not a publicly hosted YAML file.

In Profile > Appearance > Sidebar Organizer, choose **Use current layout on all devices** to
migrate the current layout, or **Upload account configuration** to publish YAML.
Both actions validate the configuration and ask before saving. Other devices
load the latest layout on reload. Download the configuration to edit it, then
upload the replacement. The ordinary Organizer editor is read-only in account
mode so it cannot silently overwrite the server configuration.

Accounts without an account record retain the existing browser/file path.
Native Home Assistant sidebar preferences retain priority and are never cleared
automatically. Remove those preferences separately if you want Organizer to take
over an account which has a native custom layout. Account mode does not use or
change the browser's file toggle, layout, hidden-panel cache, or collapse cache.
Group expansion is session-only; a reload restores configured defaults.

An unreadable, malformed or unsupported account record leaves the native sidebar
in place, displays a warning, and does not fall back to possibly stale browser
data. Reload to retry. An unavailable user-data API also takes this safe path.
This deliberately changes outage behavior for legacy clients, since the client
cannot know whether an account record exists until the request succeeds.

Removing the account record restores each device's existing browser/file setup
after reload. No legacy data is deleted during migration or removal. This is
navigation customization, not an authorization boundary: Home Assistant still
controls access to panels and entities.

## Validation and deployment

Run `node --test tests/*.test.mjs` (Node 20+ with project dependencies installed),
`node node_modules/typescript/bin/tsc --noEmit`, and the normal Rollup build.
Tests use authenticated-connection fixtures, not a live HA server or mobile app.

Deployment requires replacing the Organizer module with the built artifact and
loading it globally so fresh clients receive it. Keep every global frontend and
dashboard module reference at the **same exact URL**, including cache query
strings, to avoid evaluating the module twice. Existing global loading needs no
configuration change. Back up the current module before replacement; reload
clients afterward. Publish the account configuration while signed into the
intended account. A supervisor connection is not that user's connection.

Rollback: restore the previous module and reload clients. Account data remains
under its separate key, ignored by the previous module. Keep the original local
layout until desktop, fresh-browser, and actual phone acceptance tests pass.
HACS updates can overwrite a local build until an upstream release includes it.

## Local release maintenance

A local deployment may keep the existing registration URL as a small loader that
imports an immutable versioned build. Update both the loader JS and its precompressed
`.gz` companion. Back up both original files and record the built asset SHA-256.
Keep HACS automatic updates disabled for this extension. This is an operational
hold, not an enforced package-manager pin: a manual HACS update or redownload
replaces the loader and removes account-layout support until the patch is rebased,
reviewed, built and reinstalled. Never overwrite an immutable versioned asset.

Browser caches can retain the old registration URL. Refresh that exact asset and
open a fresh application tab; confirm the loaded version before acceptance tests.
Use the same registration URL everywhere. Do not clear unrelated browser state.
For a scoped fresh-client simulation, export the legacy layout, remove only the
Organizer saved configuration using its UI, and verify native fallback before
publishing the account layout. Restore the exported YAML through Organizer if
rolling back a client whose local configuration was cleared.
Startup waits up to 30 seconds for authenticated HA readiness before reading account data.
If readiness times out, the native sidebar remains and a reload notice is shown.
