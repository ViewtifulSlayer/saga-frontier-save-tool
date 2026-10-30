# Changelog

All notable changes to the SaGa Frontier Remastered Save Tool.

## [1.2.1] - 2026-10-30

BUILD 2026-10-30.5.

### Inspection

- The **Monster Lab** card is now always present on a loaded slot. A Monster
  PC gets the existing checklist, library and calculator; any other selection
  gets a picker of the save's Monster PCs and a compact empty state. The card
  stays in both the desktop page index and the phone "On this page" block, so
  a loaded slot now has 15 index links instead of 14.
- Phone layouts keep the Lab inside its card. The calculator controls stack,
  the library cells wrap, and the Monster PC picker and filter labels wrap with
  their controls at full width. The 300px card reports equal content and
  scroll widths for both the empty state and the full Lab.
- The stylesheet URL now carries the build stamp, so a phone-layout release
  cannot be served with a stale CSS cache. No runtime table or save-format
  change; the publish surface stays at 19 files and eleven tables.

### Verification

- 280 fixture, 961 viewer, 362 DOM, 35 platform and 136 publish checks.
- Browser pass at 1600x900, 380x700, 360x800 and 300x700 with the Asellus
  fixture: all eleven tables return 200, the empty card is in both indexes and
  selects a Monster PC, the 300px card reports 191/191, and the console stays
  empty.

## [1.2.0] - 2026-10-30

BUILD 2026-10-30.4.

### Inspection

- **Encyclopedia** card with a single searchable index of 1,016 entities:
  all 512 abilities, all 256 Monster form ids and all 248 named items. The
  type filter, name/id search and 40-row page keep the card lightweight while
  the counts stay visible in the type selector.
- Entity links on ability, form and item names throughout the existing cards,
  plus a detail drawer with the record, its documentation status and every
  place the entity appears in the loaded save. The selected entity rides in the
  address bar as `#entity/<type>/<id>`, so a record can be reloaded or shared,
  and a hash change opens or closes the drawer.
- The drawer is keyboard reachable and closes on Escape. Close clears the
  entity hash with `replaceState`, so Back does not reopen the record. The page
  index picks the card up automatically as its fourteenth entry.

### Verification

- 280 fixture, 944 viewer, 360 DOM, 35 platform and 136 publish checks.
- The viewer harness covers route parsing, link formatting, the full entity
  index, type filters, search, the 40-row cap, drawer contents, close handling
  and the wrapping rules for the entity table. The DOM harness follows
  ability, form and item hash routes, checks the drawer contents and closing
  control, and rejects an invalid route.
- Browser pass at 1600x900 and 380x700: link click, hash reload, Back and
  Escape open and close the drawer, the mobile index lists 14 links, and both
  the page and the entity table stay inside their wrappers. The 380px pass
  caught the summary column inheriting `nowrap`; the table and phone rules now
  wrap, and no console errors were logged.

## [1.1.0] - 2026-10-30

BUILD 2026-10-30.3.

### Inspection

- Monster Lab card for the selected Monster PC, with three panels that share
  one selection and one save record:
  - **Checklist** - all 128 monster abilities grouped by the six documented
    transformation categories, marked absorbed (the `getskill` history) or
    equipped (the live `eqpAtk` slot 1-8), filterable to all, absorbed, missing
    or needed by a documented form, and with every documented target form's
    requirements resolved against the current menu. Status is labelled as a
    requirements check, not a promise of the game's result.
  - **Library** - all 256 form ids with the number of reachable tables, Oulak's
    documented BHP and seven stats, hidden gear, HP condition and requirement
    rows, shown separately from the observed record; filters for documented
    stats, transformation rows and no row, plus name/id search.
  - **Calculator** - a next-absorb simulator that replaces slot 8, adds four
    Prime HP only for a new ability, applies the first matching Table 1 row,
    then starts Table 2 at the row for the current max HP and walks it in
    table order, with a full trace; a first-ability-per-category table; and a
    target planner that lists every row reaching the chosen form, what is
    missing, and a one-click suggested menu for a what-if pass.
- **Try changes** what-if mode keeps temporary absorbed/slot edits in the
  controller only. Reset to save discards them; the record and file are never
  mutated. A slot switch and a new file clear the overrides.
- The checklist, library and calculator are native `<details>` panels, so
  their open state survives a re-render and is controlled by the existing
  Monster PC picker. The controller restores focus to the edited control after
  each re-render.

### Data

- New eleventh runtime table, `docs/monster_lab.json` (155,889 bytes): 128
  monster ability categories plus six Space Magic Head entries from
  `[MTRAN04]`, and 86 documented Oulak form blocks stored as 88 form-id
  entries, with BHP, the seven stats, WP/JP/LP/Def, HP condition, hidden gear
  and the guide's own requirement lines.
- Built by `tests/sfr_save_tool/build_monster_lab.py` with gates on the six
  category counts, the 128-id monster range, the six Space Magic ids, the
  86/83 block counts, the 80 unique form ids, the 84 target forms, and ten
  fixture stat matches. `--check` fails on a stale table.
- Space Magic is treated as a Head ability for the first-ability check but
  cannot satisfy a requirement, matching the guide. Documented values are not
  reconciled with the save; the two target forms with no stat line
  (Gunfish, LiquidMetal) and Mandrake's 110 vs 160 BHP stay labelled.

### Verification

- 280 fixture, 907 viewer, 350 DOM, 35 platform and 136 publish checks.
- The viewer harness covers the category map, first-ability order, Table 1 and
  Table 2 simulation, current-form skip, Prime HP arithmetic, planner menus,
  all three filters, observed/documented separation, and missing-table
  fallbacks on both the form and lab tables.
- The DOM harness drives the real controller: Try changes, an absorb toggle, a
  slot select, the absorbed filter, the Lummox library detail, target
  selection and Load into what-if, then re-reads the record to prove no
  what-if value reached the save. The publish probe serves 19 files and eleven
  tables.

## [1.0.1] - 2026-10-30

BUILD 2026-10-30.2.

### Inspection

- Monster form panel for Monster characters: the form byte, the form name,
  base HP, Prime HP at four points per absorbed monster ability, and max HP in
  the form, plus the guide's transformation check (required abilities or body
  part, and the HP ceiling). The current form also rides on the Race line of
  the compact character summary, beside the Mec body TYPE.
- Riki's starting green Lummox is labeled as inferred from his INIT record; a
  form the guide never lists as a transformation target says so instead of
  showing an empty check.
- Monster form names and transformation rows come from the guide's hex tables
  in a new tenth runtime table, `docs/monster_forms.json` (256 form ids, 120
  requirement rows).

### Fixed

- A zero-filled scratch block is no longer read as three Mystic absorbs. Riki's
  record carries enemy id 0 with no mask or amount, which had produced three
  bogus `Rocky` rows labelled `unlisted variant`.

### Verification

- Riki is the first fixture control in both saves: form 15, 60 base HP, three
  absorbed abilities, 12 Prime HP, 72 max HP.
- 258 fixture, 815 viewer, 333 DOM, 35 platform and 123 publish checks, with an
  18-file manifest that boots all ten tables.

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
