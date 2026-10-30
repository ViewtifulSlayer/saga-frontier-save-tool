# Changelog

All notable changes to the SaGa Frontier Remastered Save Tool.

## [1.0.0] - 2026-10-30

First public release, BUILD 2026-10-30.1.

### Save intake and integrity

- Loads the game's raw DEFLATE `SaveData.bin`, a decrypted JSON mirror, or a
  byte dump entirely in the browser.
- Reports container type, inflated size, SHA-256 and a byte inspector, and
  proves a no-op round trip without writing the file.
- Lists all 59 numbered slots plus Quick and Auto (61 entries), with paging,
  a populated-only filter and per-slot character, room and play time.
- Optional Chromium folder watch with reconnect, debounce and deduplicated
  browser-local snapshots.

### Inspection

- Party, active team, money, packed Battle Rank Points, inventory and location.
- Scenario flags: 512-byte `snroFlg`, named blocks, an unofficial English
  gloss, Current / Unset / All / Chart state views, and the 1,024-byte chart.
- System file: scenario-clear record, blood type, zodiac, story arrays, profile
  bytes, counters and raw integrity fields.
- Shops: 17 fixed purchase tables, per-table progress and a still-to-buy route.
- Roster and character detail: HP/LP/WP/JP, seven stats, race, gifts, equipped
  items and arts, learned arts by school, and element coverage.
- Four INIT sets with Battle Rank prediction.
- Mec body profile: body TYPE and a Base / Parts / With parts table.
- Mystic absorbs: three weapons, stored boosts, granted arts, unknown-art
  chips and INIT/Possession variant labels.

### Data and naming

- Asset-sourced character, item, area and ability names.
- 512 abilities, 869 map ids, 69 areas, 169 named flag bytes, 710 meanings,
  4 INIT sets and 17 shop tables.
- Nine runtime tables built by gated generators, including source hashes for
  the guide-derived Mec and Mystic tables.

### Interface and reach

- Sticky page index, three-row slot pager, compact character drill-over and
  keyboard roster navigation.
- Phone layouts at 300-600px for tables, byte dumps, flags and character
  panels; desktop verified up to 1600x900.
- Cache-busted builds and a single static publish surface; no server, upload,
  analytics or save download.

### Verification

- 211 fixture, 775 viewer, 321 DOM, 35 platform and 112 publish checks.
- Manifest-only 17-file boot with all nine tables, no console errors.

### Development before 1.0.0

- `2026-10-29.24` - Mystic absorb panel and the ninth runtime table.
- `2026-10-29.23` - Mec body profile and compact-rail body TYPE.
- `2026-10-29.21` - browser folder watcher with reconnect and snapshots.
- `2026-10-29.20` - compact character drill-over.
- `2026-10-29.19` - page index, slot pager, Quick/Auto shortcuts and filter.
- Earlier - container decoding, name tables, character/ability/map/flag/shop/
  INIT panels, phone layouts and the read-only round-trip proof.
