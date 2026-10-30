# SaGa Frontier Remastered Save Tool

A read-only inspection tool for **SaGa Frontier Remastered** (PC / Unity) save
files.
Drop `SaveData.bin` or a decrypted JSON mirror into the page and inspect every
snapshot in the file: party, money, inventory, location, scenario flags, shop
progress, the full character roster, learned and equipped arts, Mystic absorbs,
Monster forms and the Monster Lab, an ability/form/item Encyclopedia, and the
four INIT stat sets.

Nothing is uploaded or edited. All parsing happens in the browser tab, and the
only download is an optional snapshot copy you export yourself.

**Live demo:** https://viewtifulslayer.github.io/saga-frontier-save-tool/

Feature history is in [CHANGELOG.md](CHANGELOG.md).

## What it shows

- **File and container** - raw DEFLATE (RFC 1951) detection, inflated payload
  size, SHA-256, a byte inspector, and a round-trip proof that the loaded bytes
  were not changed.
- **Snapshots** - all 59 numbered slots plus the quick and auto saves (61
  entries), three rows per page with Prev/Next, compact Quick and Auto
  shortcuts, and a populated-only filter, including character, room and play
  time.
- **Semi-live folder watch** - in Chromium browsers, choose the folder that
  contains `SaveData.bin` once. The tool polls the folder, reloads after the
  game writes a stable save, remembers the handle for Reconnect after a
  restart, and can keep deduplicated snapshot copies in this browser for
  export. The folder is opened read-only and is never written to.
- **Navigation** - a sticky "On this page" index beside the cards, with the
  current section marked as you scroll. On desktop it can drill into a compact
  character summary for the selected roster row, with a Back control; on phones
  the index becomes a collapsed block above the cards.
- **Party and economy** - leader, active team, money, and the packed Battle
  Rank Points byte shown as a rank plus progress.
- **Inventory** - the 257-entry item array with asset-sourced names.
- **Location** - current room id and name, area index and name, previous map,
  position and region.
- **Scenario flags** - the 512-byte `snroFlg` with named blocks, an unofficial
  English gloss, Current / Unset / All / Chart state views, and the separate
  1,024-byte chart array.
- **System file** - scenario-clear record, blood type, zodiac, story arrays,
  profile bytes, counters, and the raw integrity fields.
- **Shops** - the 17 fixed purchase tables, per-table progress for Shopaholic,
  and a still-to-buy route grouped by location.
- **Roster and character detail** - HP/LP/WP/JP, seven stats, race, gifts,
  equipped arts and items, learned arts by school, and element flags.
- **Mec body profile** - for Mec characters, the body TYPE and a Base / Parts /
  With parts table for HP and the seven stats, built from the guide's Mec item
  stat chart, with each equipped part's boosts shown beside it.
- **Mystic absorbs** - for Mystic characters, the three weapon absorbs stored
  in the save, with the absorbed monster, stored boosts and granted art. A
  chip marks a weapon art the record does not know, and INIT or Possession
  variants are labeled from the guide instead of being recomputed.
- **Monster forms** - for Monster characters, the current form, its base HP,
  and Prime HP at four points per absorbed monster ability, with the guide's
  transformation check for that form (required abilities or body part, and the
  HP ceiling). The compact character summary also names the current form on
  its Race line, as it does for a Mec body TYPE. Riki's starting green Lummox
  is labeled as inferred from his INIT record because it is not a
  transformation target.
- **Monster Lab** - one card on every loaded slot, driven by the save. For a
  Monster PC it shows a 128-ability checklist grouped by the six transformation
  categories, marked absorbed or equipped and filterable by absorbed, missing
  or needed; a form library of all 256 ids with Oulak's documented BHP, stats,
  hidden gear and transformation rows; and a calculator that simulates the next
  absorb in the documented 8, 1-7 slot order, resolves the Table 1 and Table 2
  checks, and plans the menu for a target form. For any other selection it
  offers a picker of the save's Monster PCs and a compact empty state, so the
  section stays in both page indexes. A Try changes mode keeps the what-if menu
  temporary and never writes to the file.
- **Encyclopedia** - a searchable index of all 512 abilities, 256 Monster form
  ids and 248 named items, assembled from tables the page already loads. Open
  any name for its record, documentation status and every place it appears in
  the save. The selection is kept in the address bar (`#entity/<type>/<id>`),
  so a record can be reloaded or shared.
- **Ability tables** - eight ability schools with holder counts, and element
  coverage across the roster.
- **INIT sets** - all four documented INIT rosters, scored against the save,
  with the guide's prediction rule.

Every table has a phone layout: below 600px rows become labeled blocks rather
than sideways-scrolling tables.

## Privacy

- The file is read once with `FileReader`, cloned, and parsed locally.
- No server, no analytics, no upload.
- The only requests the page makes are the eleven local table files under
  `docs/`.
- The browser folder watcher stores its directory handle, settings and any
  snapshot copies in local IndexedDB. That store stays on this device and is
  never sent anywhere.
- A pristine copy of the original bytes is held aside and re-hashed after
  rendering; it is never handed to a parser.

## Running locally

No build step, no dependencies. Serve the folder over HTTP:

```sh
python -m http.server 8099
```

Then open `http://127.0.0.1:8099/`. Opening `index.html` from disk with
`file://` cannot fetch the tables, so the page will load but names and dates
will be missing.

Folder watching needs a Chromium browser and a secure context; `localhost` and
GitHub Pages both qualify. The page stores the directory handle and optional
snapshots in IndexedDB. A saved handle usually needs one Reconnect click after
a browser restart; `SaveData.bin` itself is never written.

On Windows the game writes saves to:

```
Documents/My Games/SaGa Frontier Remastered/Steam/<steamid>/SaveData/SaveData.bin
```

`AppSetting.bin` sits beside it. The tool accepts `SaveData.bin`, a
decrypted `.json` mirror, or a `.dat` dump.

## Data sources and credit

Character, item and area names are extracted from the game's own name tables in
`resources.assets`, not from community posts. Community documentation supplies
the meanings layered on top:

- **SF Data Project** - Zaraktheus (Data Mechanics Guide, ability elements,
  monster tables), Erroneous_Waylay (INIT rosters, character record layout,
  skills, items, maps), Mir_Vimes (PS1 structure dumps). These three are
  presentations of one body of work, not independent sources.
- **Scenario flags** - a Japanese per-byte map from the community Discord
  corpus. The English gloss in `docs/flag_meanings_en.json` is an unofficial
  draft, labelled as such in the tool.
- **Shop labels** - each stock list is matched to its documented sale location
  at [Essence of Saga](https://essenceofsaga.wordpress.com/home/book-index/item-selling/),
  cross-checked against the Shopaholic grouping.
- **Container format** - cross-checked against
  [save-editor.com's converter](https://www.save-editor.com/tools/pc_game_save_converter_title_SaGa_Frontier_Remastered.html).

The tool does not ship game assets. It ships names, ids and facts about the
save format.

## Status and limitations

- **Read-only.** There is no editor UI and no `SaveData.bin` download. A
  span-splicing write path exists and is proven byte-exact for a no-op, but it
  is deliberately not wired up. Snapshot export downloads a copy from the
  browser's own snapshot store.
- **Integrity fields are unmapped.** `sfSys.chk`, `chk2`, `chk3`, `chk4` and
  the `sum` fields are displayed raw and never validated or recomputed.
- **Battle Rank decoding is documented, not observed.** No test save has a
  completed scenario, so INIT 2-4 and the BRP boundaries remain unconfirmed.
- **343 flag bytes are unnamed**, and the 1,024-byte chart array has no meaning
  table.
- **Area semantics are unresolved.** The area index cannot be distinguished
  between "current area" and "scenario start area" with the saves available
  here.
- Names marked `documented` come from community tables and are not verified
  against your file. Names marked `asset` come from the game itself.
- **Monster form names, transformation rows and stat lines are documented,
  not observed.** The form byte, base HP, Prime HP and equipped menu are read
  from your save; the names, requirement rows and BHP/stat lines come from the
  guide's transformation tables and Oulak's Monster FAQ. Riki's green Lummox
  is inferred from his INIT record and the Monster FAQ because the
  transformation tables never list a starting form. Documented and observed
  values are shown side by side and are never reconciled.
- **The Monster Lab calculator models the documented check, not the game.**
  It applies the first matching row in table order, starts Table 2 at the row
  for the current max HP, treats Space Magic as a Head ability that cannot
  satisfy a requirement, and adds four Prime HP only for a new ability. A
  successful absorb is an input, not something the tool can predict.
- **Two target forms have no documented stat line** (Gunfish and LiquidMetal),
  and three blocks carry no BHP line (the two `**` variants and Ghostrider).
  Mandrake's documented 110 BHP differs from the 160 stored in the fixture
  record. The library labels these facts instead of patching them.

## Verification

The project is checked with four Node harnesses (descriptor checks, a DOM
stub that drives the real controller, a fake-directory adapter test, and a
fixture audit against two real saves), plus a publish probe that serves only
the files in this repository. The Monster Lab adds the generated-table gates
(`build_monster_lab.py --check`) and calculator assertions to the viewer and
fixture harnesses. They live in the maintainer's workspace and are not part of
this repository.

## License

MIT. See [LICENSE](LICENSE).

SaGa Frontier is a trademark of Square Enix. This project is unaffiliated with
Square Enix and ships no game assets.
