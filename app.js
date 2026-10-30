/*
 * SaGa Frontier Remastered - read-only save tool.
 *
 * Constraints (see docs/project_runbook.md):
 *   - Client-side only. No backend, no build step, no dependencies.
 *   - The dropped/chosen file is read once through FileReader. A pristine clone
 *     is published as window.originalSaveData and never handed to a parser.
 *     Parsing always runs on a separate working copy.
 *   - The UI is read-only: nothing is downloaded or written to disk. The writer
 *     below builds bytes in memory only, and is exercised by the round-trip proof.
 *
 * Data shape note: the save file is JSON text. DataView is used to inspect the
 * byte stream (size, leading bytes, marker offsets, hex dump); field values are
 * read from the parsed JSON. Byte offsets are diagnostic, not a field map.
 */
(function (global) {
  'use strict';

  var CONSTANTS_PATH = 'docs/constants.json';
  // Ability names come from the community data project via the gameinfo build.
  // They live outside docs/gameinfo/ because that tree is local research only
  // and must never be deployed.
  var ABILITY_PATH = 'docs/ability_names.json';
  var MAP_PATH = 'docs/map_names.json';
  // Scenario flag byte meanings, from the community flag note. Deployable like
  // the other runtime tables; docs/gameinfo/ itself never ships.
  var FLAG_PATH = 'docs/flag_names.json';
  // Per-character INIT 1-4 baselines, exported from characters_init.json.
  var INIT_PATH = 'docs/init_sets.json';
  // Unofficial English glosses for the Japanese flag meanings, plus the shared
  // glossary. Optional: without it the card renders the source text alone.
  var FLAG_EN_PATH = 'docs/flag_meanings_en.json';
  // Location labels for shopRecordList Type ids, matched from sale locations.
  var SHOP_PATH = 'docs/shop_names.json';
  // Mec item stat boosts, from the Data Mechanics Guide's ITEMD03 chart. Only
  // the Mec column ships; the other races use different boost tables.
  var ITEM_STATS_PATH = 'docs/item_stats.json';
  // Mystic absorb names, granted arts and the guide's documented boost rows.
  // The save only stores the enemy id, stat mask and amount, so this table is
  // what turns those bytes into a monster name and an art name.
  var MYSTIC_ABSORB_PATH = 'docs/mystic_absorbs.json';
  // Monster form names and the guide's documented transformation targets. The
  // save only stores a form id in tribial_work.data[0]; this table turns that
  // byte into a name and lists the ability sets that reach the form.
  var MONSTER_FORMS_PATH = 'docs/monster_forms.json';
  var MONSTER_RACES = [0x08, 0x98];
  // Monster abilities are ids 128-255, the block the ability table calls
  // `monster`. Prime HP is four points per distinct absorbed ability.
  var MONSTER_ABILITY_LOW = 128;
  var MONSTER_ABILITY_HIGH = 255;
  var PRIME_HP_PER_ABILITY = 4;
  var MONSTER_CATEGORY_LABELS = {
    head: 'Head',
    arm: 'Arm',
    leg: 'Leg',
    body: 'Body',
    breath: 'Breath',
    magical: 'Magical'
  };
  // One build identifier, used three ways: the script URLs in index.html, the
  // version query on every runtime table fetch, and the stamp in the header.
  // Bump it whenever app.js, platform.js or a table changes. verify_viewer.js
  // fails if the index.html copies drift from this constant, which is the only
  // silent way a stale page could keep being served.
  var BUILD = '2026-10-30.2';
  var SLOT_PAGE_SIZE = 3;
  // Browser-only live-folder preferences. The directory handle itself lives in
  // IndexedDB inside platform.js; this is only the user's chosen behavior.
  var LIVE_SETTINGS_KEY = 'sfr-save-viewer.live-settings.v1';
  var LIVE_DEFAULT_SETTINGS = {
    watch: true,
    autoReload: true,
    snapshots: false,
    retention: 10,
    interval: 2000
  };

  function sanitizeLiveSettings(raw) {
    raw = raw || {};
    var settings = Object.assign({}, LIVE_DEFAULT_SETTINGS);
    if (typeof raw.watch === 'boolean') settings.watch = raw.watch;
    if (typeof raw.autoReload === 'boolean') settings.autoReload = raw.autoReload;
    if (typeof raw.snapshots === 'boolean') settings.snapshots = raw.snapshots;
    var interval = Number(raw.interval);
    if (interval === 2000 || interval === 5000 || interval === 10000) settings.interval = interval;
    var retention = Number(raw.retention);
    if (retention === 3 || retention === 5 || retention === 10 || retention === 25) settings.retention = retention;
    return settings;
  }
  var SLOT_BLOB_MARKER = '"saveDataJsonStr":"';

  // A new build must not mix with an old cached table, so the version travels
  // in the URL. The request also keeps cache: 'no-store' as a second guard.
  function tableUrl(path) {
    return path + (path.indexOf('?') === -1 ? '?' : '&') + 'v=' + encodeURIComponent(BUILD);
  }

  // getskill is a 64-byte bit grid, not a list of ids. Byte 0 of the grid is
  // record byte 0x38, and ability id = gridIndex * 8 + bit (msb first).
  var SKILL_GRID_BYTES = 64;

  var SENTINELS = {
    character: 255,
    item: 255,
    equipAttack: 65535,
    equipItem: 255
  };

  /* ------------------------------------------------------------------ *
   * Value helpers
   * ------------------------------------------------------------------ */

  function num(value) {
    if (typeof value === 'number' && isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      var parsed = Number(value);
      if (isFinite(parsed)) return parsed;
    }
    return null;
  }

  function str(value) {
    return typeof value === 'string' ? value : '';
  }

  function toNumberArray(value) {
    return Array.isArray(value) ? value.map(num) : [];
  }

  function hexByte(value) {
    return Number(value).toString(16).toUpperCase().padStart(2, '0');
  }

  function hex2(value) {
    var n = num(value);
    if (n === null) return '0x??';
    var digits = Math.abs(Math.trunc(n)).toString(16).toUpperCase();
    if (digits.length < 2) digits = '0' + digits;
    return '0x' + digits;
  }

  // Map ids are keyed with three digits (0x016, 0x4B9) to match map_names.json.
  function hex3(value) {
    var n = num(value);
    if (n === null) return '0x???';
    return '0x' + Math.abs(Math.trunc(n)).toString(16).toUpperCase().padStart(3, '0');
  }

  // The key the map table is indexed by; null ids must not answer as 0x000.
  function mapKey(value) {
    var n = num(value);
    if (n === null) return '';
    return hex3(n);
  }

  // mapwk.imfName names the loaded map asset: "imf303" is IMF303, map 0x303.
  // This is the current room. mapwk.map_name and saveItemInfoData.MapNumber are
  // a different field: they stay at 26 while the player moves between rooms, so
  // neither may be used as a room id.
  function imfIdFromName(name) {
    if (typeof name !== 'string') return null;
    var match = /^imf\s*([0-9A-Fa-f]{1,4})$/i.exec(name.trim());
    return match ? parseInt(match[1], 16) : null;
  }

  // Slots are described before their inner blob is parsed, so the map id is
  // lifted out of the text rather than by parsing ~68 KB of JSON per slot.
  function imfMapId(raw) {
    if (typeof raw !== 'string') return null;
    var match = /"imfName"\s*:\s*"imf([0-9A-Fa-f]{1,4})"/.exec(raw);
    return match ? parseInt(match[1], 16) : null;
  }

  // Ability ids span 0x0000-0x01FF and are keyed with four digits.
  function hex4(value) {
    var n = num(value);
    if (n === null) return '0x????';
    return '0x' + Math.abs(Math.trunc(n)).toString(16).toUpperCase().padStart(4, '0');
  }

  function formatNumber(value) {
    var n = num(value);
    return n === null ? '-' : n.toLocaleString('en-US');
  }

  function formatPlayTime(hours, minutes) {
    var h = num(hours);
    var m = num(minutes);
    if (h === null && m === null) return '-';
    return (h || 0) + 'h ' + (m || 0) + 'm';
  }

  /* ------------------------------------------------------------------ *
   * Buffer safety
   *
   * ArrayBuffer contents cannot be frozen in JavaScript; the guarantee is
   * structural. The pristine buffer is only ever handed out as a read-only
   * binding, parsing always receives a separate copy, and the SHA-256 is
   * recomputed afterward to prove nothing moved.
   * ------------------------------------------------------------------ */

  function cloneBuffer(buffer) {
    if (!(buffer instanceof ArrayBuffer)) {
      throw new TypeError('cloneBuffer expects an ArrayBuffer.');
    }
    return buffer.slice(0);
  }

  function publishOriginal(buffer) {
    if (!buffer) {
      try {
        delete global.originalSaveData;
      } catch (err) { /* non-fatal */ }
      return null;
    }
    try {
      Object.defineProperty(global, 'originalSaveData', {
        value: buffer,
        writable: false,
        configurable: true,
        enumerable: true
      });
    } catch (err) {
      try {
        global.originalSaveData = buffer;
      } catch (inner) { /* non-fatal */ }
    }
    return buffer;
  }

  function bytesToHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  function sha256Hex(buffer) {
    if (!global.crypto || !global.crypto.subtle) {
      return Promise.resolve(null);
    }
    return global.crypto.subtle.digest('SHA-256', buffer).then(function (digest) {
      return bytesToHex(new Uint8Array(digest));
    });
  }

  /* ------------------------------------------------------------------ *
   * FileReader intake
   * ------------------------------------------------------------------ */

  function readFileAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      if (typeof FileReader === 'undefined') {
        reject(new Error('This browser does not expose the FileReader API.'));
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        if (!(reader.result instanceof ArrayBuffer)) {
          reject(new Error('FileReader did not return an ArrayBuffer.'));
          return;
        }
        resolve(reader.result);
      };
      reader.onerror = function () {
        var detail = reader.error && reader.error.message ? ': ' + reader.error.message : '.';
        reject(new Error('FileReader could not read the file' + detail));
      };
      reader.onabort = function () {
        reject(new Error('The file read was aborted.'));
      };
      try {
        reader.readAsArrayBuffer(file);
      } catch (err) {
        reject(new Error('FileReader rejected the file: ' + err.message));
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Byte stream inspection (DataView)
   * ------------------------------------------------------------------ */

  function sniffBytes(buffer) {
    var view = new DataView(buffer);
    var length = view.byteLength;
    var head = [];
    var headLimit = Math.min(16, length);
    for (var i = 0; i < headLimit; i++) head.push(view.getUint8(i));
    var tail = [];
    for (var j = Math.max(0, length - 16); j < length; j++) tail.push(view.getUint8(j));

    var hasBom = length >= 3 && head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF;
    var lead = length > 0 ? (hasBom && length > 3 ? head[3] : head[0]) : null;

    return {
      byteLength: length,
      firstBytes: head,
      lastBytes: tail,
      hasUtf8Bom: hasBom,
      leadingByte: lead,
      looksLikeJson: lead === 0x7B
    };
  }

  function hexDump(buffer, maxBytes) {
    var view = new DataView(buffer);
    var limit = Math.min(view.byteLength, maxBytes || 256);
    var rows = [];
    for (var offset = 0; offset < limit; offset += 16) {
      var hex = [];
      var ascii = '';
      for (var i = 0; i < 16; i++) {
        var at = offset + i;
        if (at >= limit) {
          hex.push('  ');
          continue;
        }
        var byte = view.getUint8(at);
        hex.push(hexByte(byte));
        ascii += (byte >= 0x20 && byte < 0x7F) ? String.fromCharCode(byte) : '.';
      }
      rows.push({ offset: offset, hex: hex.join(' ').replace(/\s+$/, ''), ascii: ascii });
    }
    return rows;
  }

  function indexOfBytes(buffer, needle, fromIndex) {
    if (!needle.length) return -1;
    var haystack = new Uint8Array(buffer);
    var start = fromIndex || 0;
    var last = haystack.length - needle.length;
    outer: for (var i = start; i <= last; i++) {
      for (var j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  function asciiBytes(text) {
    var out = [];
    for (var i = 0; i < text.length; i++) out.push(text.charCodeAt(i) & 0xFF);
    return out;
  }

  // options.containerKind: 'json' or 'deflate-raw'. options.payload is the
  // inflated buffer when the container was compressed; the marker scan and the
  // text length describe that payload, while the hex dump describes the bytes
  // on disk.
  function inspectBytes(buffer, text, options) {
    options = options || {};
    var payload = options.payload instanceof ArrayBuffer ? options.payload : buffer;
    var sniff = sniffBytes(buffer);
    var needle = asciiBytes(SLOT_BLOB_MARKER);
    var firstOffset = indexOfBytes(payload, needle, 0);
    var occurrences = 0;
    var cursor = firstOffset;
    while (cursor !== -1) {
      occurrences++;
      cursor = indexOfBytes(payload, needle, cursor + 1);
    }
    return Object.freeze({
      byteLength: sniff.byteLength,
      payloadByteLength: payload.byteLength,
      containerKind: options.containerKind || 'json',
      textLength: text.length,
      hasUtf8Bom: sniff.hasUtf8Bom,
      leadingByte: sniff.leadingByte,
      leadingChar: sniff.leadingByte === null ? '' : String.fromCharCode(sniff.leadingByte),
      looksLikeJson: sniff.looksLikeJson,
      firstBytesHex: sniff.firstBytes.map(hexByte).join(' '),
      lastBytesHex: sniff.lastBytes.map(hexByte).join(' '),
      marker: SLOT_BLOB_MARKER,
      markerOffset: firstOffset,
      markerCount: occurrences,
      rows: hexDump(buffer, 256)
    });
  }

  /* ------------------------------------------------------------------ *
   * Decode and parse
   * ------------------------------------------------------------------ */

  function decodeContainer(buffer) {
    var text = new TextDecoder('utf-8').decode(new Uint8Array(buffer));
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var first = text.replace(/^\s+/, '').charAt(0);
    if (first !== '{') {
      throw new Error(
        'This does not look like a JSON save container: the first non-whitespace ' +
        'character is "' + first + '". The byte table above shows what was read. ' +
        'A wrapped, encrypted or non-JSON file needs its container format ' +
        'characterized before it can be parsed.'
      );
    }
    return text;
  }

  function parseContainer(text) {
    var container;
    try {
      container = JSON.parse(text);
    } catch (err) {
      throw new Error('Save container is not valid JSON: ' + err.message);
    }
    if (!container || typeof container !== 'object' || Array.isArray(container)) {
      throw new Error('Save container root is not an object.');
    }
    if (!Array.isArray(container.saveDataList)) {
      throw new Error('saveDataList is missing or is not an array.');
    }
    return container;
  }

  /* ------------------------------------------------------------------ *
   * Slots
   * ------------------------------------------------------------------ */

  function describeSlot(kind, index, entry) {
    var meta = (entry && entry.saveItemInfoData) || {};
    var raw = entry && typeof entry.saveDataJsonStr === 'string' ? entry.saveDataJsonStr : '';
    return {
      kind: kind,
      index: index,
      key: kind + ':' + (index === null ? 'single' : index),
      characterNumber: num(meta.CharacterNumber),
      characterName: str(meta.CharacterName),
      // Metadata MapNumber is the area index, not the room; the inner blob's
      // IMF name is the room. Both are kept so the picker can show each.
      mapNumber: num(meta.MapNumber),
      mapId: imfMapId(raw),
      hours: num(meta.PlayTimeHours),
      minutes: num(meta.PlayTimeMinutes),
      hasData: raw.length > 0,
      isEmpty: raw.length === 0 && str(meta.CharacterName) === ''
    };
  }

  function listSlots(container) {
    var slots = (container.saveDataList || []).map(function (entry, index) {
      return describeSlot('slot', index, entry);
    });
    if (container.quickSaveData) slots.push(describeSlot('quick', null, container.quickSaveData));
    if (container.autoSaveData) slots.push(describeSlot('auto', null, container.autoSaveData));
    return slots;
  }

  function entryFor(container, ref) {
    if (!ref) return null;
    if (ref.kind === 'slot') return container.saveDataList[ref.index] || null;
    if (ref.kind === 'quick') return container.quickSaveData || null;
    if (ref.kind === 'auto') return container.autoSaveData || null;
    return null;
  }

  function parseSlot(container, ref) {
    var entry = entryFor(container, ref);
    if (!entry) throw new Error('Slot not found in this save container.');
    var raw = entry.saveDataJsonStr;
    if (typeof raw !== 'string' || raw.trim() === '') {
      return { empty: true, data: null };
    }
    try {
      return { empty: false, data: JSON.parse(raw) };
    } catch (err) {
      throw new Error('Slot inner save blob is not valid JSON: ' + err.message);
    }
  }

  /* ------------------------------------------------------------------ *
   * Container decompression
   *
   * A real SaveData.bin is a raw DEFLATE stream (RFC 1951): no zlib header, no
   * gzip header, no trailer. DecompressionStream('deflate-raw') is the only
   * browser decoder that accepts it. An already-inflated .json mirror still
   * works, and the first byte decides which path to take, so the same intake
   * handles both without a mode switch.
   * ------------------------------------------------------------------ */

  function decompressRaw(buffer) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error(
        'This browser does not expose DecompressionStream, so a raw-DEFLATE ' +
        'save cannot be inflated. Load an inflated .json mirror instead.'
      ));
    }
    var stream = new DecompressionStream('deflate-raw');
    var result = new Response(stream.readable).arrayBuffer();
    var writer = stream.writable.getWriter();
    // Swallow the writer-side rejection: the Response promise carries the same
    // failure and is the one awaited, so an unhandled rejection must not leak.
    writer.write(new Uint8Array(buffer)).catch(function () {});
    writer.close().catch(function () {});
    return result;
  }

  // Decode either container shape. Returns the JSON text and the buffer that
  // text came from, so the round-trip proof can compare like with like.
  async function decodeSavePayload(buffer) {
    var jsonError = null;
    try {
      return { text: decodeContainer(buffer), payload: buffer, containerKind: 'json' };
    } catch (err) {
      jsonError = err;
    }

    var inflated;
    try {
      inflated = await decompressRaw(buffer);
    } catch (err) {
      throw new Error(
        jsonError.message + ' A raw-DEFLATE decompression attempt also failed (' +
        err.message + '), so this is neither a JSON payload nor a DEFLATE stream.'
      );
    }

    return {
      text: decodeContainer(inflated),
      payload: inflated,
      containerKind: 'deflate-raw'
    };
  }

  /* ------------------------------------------------------------------ *
   * Write path and round-trip proof
   *
   * The container must never be re-serialized: JSON.stringify turns 1.0 into
   * 1, shortening the file and risking rejection by the game. Writes therefore
   * splice only the span of the value being changed and leave every other byte
   * untouched. With no edits the output is the original buffer, byte for byte.
   * ------------------------------------------------------------------ */

  function isSpace(ch) {
    return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
  }

  function skipSpace(text, index) {
    var i = index;
    while (i < text.length && isSpace(text[i])) i++;
    return i;
  }

  function scanString(text, index) {
    var i = index + 1;
    while (i < text.length) {
      var ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') return { start: index, end: i + 1 };
      i++;
    }
    throw new Error('Unterminated string at character ' + index);
  }

  function scanValue(text, index) {
    var i = skipSpace(text, index);
    var ch = text[i];
    if (ch === '"') return scanString(text, i);
    if (ch === '{' || ch === '[') {
      var close = ch === '{' ? '}' : ']';
      var depth = 0;
      var j = i;
      while (j < text.length) {
        var c = text[j];
        if (c === '"') { j = scanString(text, j).end; continue; }
        if (c === ch) depth++;
        else if (c === close) {
          depth--;
          if (depth === 0) return { start: i, end: j + 1 };
        }
        j++;
      }
      throw new Error('Unterminated container at character ' + i);
    }
    var start = i;
    while (i < text.length && '{}[],:"'.indexOf(text[i]) === -1 && !isSpace(text[i])) i++;
    if (i === start) throw new Error('Cannot read a value at character ' + start);
    return { start: start, end: i };
  }

  function findValueSpan(text, path) {
    var offset = skipSpace(text, 0);
    for (var step = 0; step < path.length; step++) {
      var key = path[step];
      var node = scanValue(text, offset);
      var isArray = text[node.start] === '[';
      if (isArray !== (typeof key === 'number')) {
        throw new Error('Path segment ' + JSON.stringify(key) + ' does not match container type.');
      }

      var cursor = node.start + 1;
      var found = null;

      if (isArray) {
        for (var index = 0; index <= key; index++) {
          cursor = skipSpace(text, cursor);
          var element = scanValue(text, cursor);
          if (index === key) { found = element; break; }
          cursor = skipSpace(text, element.end);
          if (text[cursor] === ',') cursor++;
        }
      } else {
        while (cursor < text.length) {
          cursor = skipSpace(text, cursor);
          if (text[cursor] === '}') break;
          var keyToken = scanString(text, cursor);
          var keyName = JSON.parse(text.slice(keyToken.start, keyToken.end));
          cursor = skipSpace(text, keyToken.end);
          if (text[cursor] !== ':') throw new Error('Expected ":" at character ' + cursor);
          var value = scanValue(text, cursor + 1);
          if (keyName === key) { found = value; break; }
          cursor = skipSpace(text, value.end);
          if (text[cursor] === ',') cursor++;
        }
      }

      if (!found) throw new Error('Path not found: ' + path.join('.'));
      offset = found.start;
    }
    return scanValue(text, offset);
  }

  function getValueByPath(target, path) {
    var node = target;
    for (var i = 0; i < path.length; i++) {
      if (node === null || node === undefined) return undefined;
      node = node[path[i]];
    }
    return node;
  }

  function slotPathFor(ref) {
    if (ref.kind === 'slot') return ['saveDataList', ref.index, 'saveDataJsonStr'];
    if (ref.kind === 'quick') return ['quickSaveData', 'saveDataJsonStr'];
    if (ref.kind === 'auto') return ['autoSaveData', 'saveDataJsonStr'];
    throw new Error('Unknown slot kind: ' + ref.kind);
  }

  function buildOutput(buffer, edits) {
    var list = edits || [];
    if (!list.length) return cloneBuffer(buffer);

    var text = decodeContainer(buffer);
    var container = parseContainer(text);

    var groups = {};
    list.forEach(function (edit) {
      var key = edit.slot.key;
      if (!groups[key]) groups[key] = { ref: edit.slot, edits: [] };
      groups[key].edits.push(edit);
    });

    var patches = [];
    Object.keys(groups).forEach(function (key) {
      var group = groups[key];
      var entry = entryFor(container, group.ref);
      if (!entry || typeof entry.saveDataJsonStr !== 'string') {
        throw new Error('Slot has no inner blob: ' + key);
      }

      var innerText = entry.saveDataJsonStr;

      // Resolve every span against the untouched inner text, then splice from
      // the end so earlier offsets stay valid.
      var spans = group.edits.map(function (edit) {
        return { span: findValueSpan(innerText, edit.path), edit: edit };
      }).sort(function (a, b) { return b.span.start - a.span.start; });

      spans.forEach(function (item) {
        var literal = JSON.stringify(item.edit.value);
        if (literal === undefined) {
          throw new Error('Value is not JSON-serializable for ' + item.edit.path.join('.'));
        }
        innerText = innerText.slice(0, item.span.start) + literal + innerText.slice(item.span.end);
      });

      var reparsed = JSON.parse(innerText);
      group.edits.forEach(function (edit) {
        var actual = getValueByPath(reparsed, edit.path);
        if (JSON.stringify(actual) !== JSON.stringify(edit.value)) {
          throw new Error('Edit did not apply cleanly at ' + edit.path.join('.'));
        }
      });

      var outerSpan = findValueSpan(text, slotPathFor(group.ref));
      patches.push({
        start: outerSpan.start + 1,
        end: outerSpan.end - 1,
        value: JSON.stringify(innerText).slice(1, -1)
      });
    });

    patches.sort(function (a, b) { return b.start - a.start; });
    patches.forEach(function (patch) {
      text = text.slice(0, patch.start) + patch.value + text.slice(patch.end);
    });

    return new TextEncoder().encode(text).buffer;
  }

  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function firstDiff(a, b) {
    var limit = Math.min(a.length, b.length);
    for (var i = 0; i < limit; i++) {
      if (a[i] !== b[i]) return i;
    }
    return a.length === b.length ? -1 : limit;
  }

  function changedRegion(before, after) {
    var prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    var suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix &&
           before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    return {
      prefix: prefix,
      suffix: suffix,
      changedInOriginal: before.length - prefix - suffix,
      changedInOutput: after.length - prefix - suffix
    };
  }

  function proveRoundTrip(buffer, text, container, ref, containerKind) {
    var original = new Uint8Array(buffer);
    var report = {
      // For a compressed container the caller passes the inflated payload, so
      // every byte comparison below is payload-against-payload. Recompression
      // is out of scope and is stated as such rather than silently skipped.
      containerKind: containerKind || 'json',
      byteLength: original.length,
      textLength: text.length,
      passthroughExact: bytesEqual(original, new TextEncoder().encode(text)),
      outerExact: false,
      outerFirstDiff: null,
      innerExact: null,
      noOpWriteExact: false,
      edit: null
    };

    try {
      var reOuter = JSON.stringify(JSON.parse(text));
      report.outerExact = reOuter === text;
      if (!report.outerExact) {
        var at = firstDiff(text, reOuter);
        report.outerFirstDiff = {
          index: at,
          original: text.slice(at, at + 40),
          reserialized: reOuter.slice(at, at + 40)
        };
      }
    } catch (err) {
      report.outerFirstDiff = { index: -1, original: err.message, reserialized: '' };
    }

    if (container && ref) {
      var entry = entryFor(container, ref);
      var innerText = entry && entry.saveDataJsonStr;
      if (typeof innerText === 'string' && innerText.length) {
        try {
          report.innerExact = JSON.stringify(JSON.parse(innerText)) === innerText;
        } catch (err) {
          report.innerExact = false;
        }

        try {
          report.noOpWriteExact = bytesEqual(original, new Uint8Array(buildOutput(buffer, [])));
        } catch (err) {
          report.noOpWriteExact = false;
        }

        try {
          var model = JSON.parse(innerText);
          var current = getValueByPath(model, ['pty', 'money']);
          if (typeof current === 'number') {
            var next = current + 1;
            var edited = buildOutput(buffer, [{ slot: ref, path: ['pty', 'money'], value: next }]);
            var editedText = decodeContainer(edited);
            var editedContainer = parseContainer(editedText);
            var editedInner = JSON.parse(entryFor(editedContainer, ref).saveDataJsonStr);
            report.edit = {
              path: 'pty.money',
              from: current,
              to: next,
              reapplied: getValueByPath(editedInner, ['pty', 'money']) === next,
              lengthDelta: edited.byteLength - buffer.byteLength,
              region: changedRegion(original, new Uint8Array(edited))
            };
          }
        } catch (err) {
          report.edit = { path: 'pty.money', from: null, to: null, reapplied: false, error: err.message };
        }
      }
    }

    return report;
  }

  function diffModels(a, b, basePath, out, limit) {
    out = out || [];
    limit = limit || 200;
    var path = basePath || [];
    if (out.length >= limit) return out;

    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' ||
        Array.isArray(a) !== Array.isArray(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: path.slice(), a: a, b: b });
      return out;
    }

    if (Array.isArray(a)) {
      if (a.length !== b.length) out.push({ path: path.concat('length'), a: a.length, b: b.length });
      var count = Math.min(a.length, b.length);
      for (var i = 0; i < count && out.length < limit; i++) {
        diffModels(a[i], b[i], path.concat(i), out, limit);
      }
      return out;
    }

    var keys = {};
    Object.keys(a).forEach(function (k) { keys[k] = true; });
    Object.keys(b).forEach(function (k) { keys[k] = true; });
    Object.keys(keys).forEach(function (k) {
      if (out.length >= limit) return;
      var hasA = Object.prototype.hasOwnProperty.call(a, k);
      var hasB = Object.prototype.hasOwnProperty.call(b, k);
      if (!hasA || !hasB) {
        out.push({ path: path.concat(k), a: hasA ? a[k] : undefined, b: hasB ? b[k] : undefined });
        return;
      }
      diffModels(a[k], b[k], path.concat(k), out, limit);
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * View model (pure, read-only projection)
   * ------------------------------------------------------------------ */

  function extractItems(itemList) {
    var out = [];
    itemList.forEach(function (slot, index) {
      if (!slot || typeof slot !== 'object') return;
      var itemNo = num(slot.itemNo);
      var count = num(slot.itemCnt);
      if (itemNo === null) return;
      if (itemNo === SENTINELS.item && !count) return;
      out.push({ index: index, itemNo: itemNo, count: count === null ? 0 : count });
    });
    return out;
  }

  // Decode the 64-byte learned-arts bit grid into ability ids.
  function decodeSkillGrid(values) {
    var out = [];
    var bytes = toNumberArray(values);
    for (var byteIndex = 0; byteIndex < SKILL_GRID_BYTES && byteIndex < bytes.length; byteIndex++) {
      var byteValue = bytes[byteIndex];
      if (byteValue === null || byteValue === 0) continue;
      for (var bit = 0; bit < 8; bit++) {
        if (byteValue & (0x80 >> bit)) {
          out.push({ abilityId: byteIndex * 8 + bit, byte: byteIndex, bit: bit });
        }
      }
    }
    return out;
  }

  function extractRoster(ply) {
    var out = [];
    ply.forEach(function (record, index) {
      if (!record || typeof record !== 'object') return;
      out.push({
        index: index,
        chrNo: num(record.chrNo),
        hpMax: num(record.hpMax),
        lp: [num(record.lpNow), num(record.lpMax)],
        wp: [num(record.wpNow), num(record.wpMax)],
        jp: [num(record.jpNow), num(record.jpMax)],
        stats: {
          str: num(record.strNow),
          dex: num(record.dexNow),
          hnd: num(record.hndNow),
          mnd: num(record.mndNow),
          mgc: num(record.mgcNow),
          con: num(record.conNow),
          chm: num(record.chmNow)
        },
        race: num(record.race),
        nature: num(record.nature),
        getType: num(record.getType),
        // Race-specific scratch area. For a Mec, data[0] is the body TYPE index
        // and data[2] mirrors hpMax; Monsters use data[0] as a form index.
        tribialWork: toNumberArray(record.tribial_work && record.tribial_work.data),
        equipAttack: toNumberArray(record.eqpAtk).filter(function (v) {
          return v !== null && v !== SENTINELS.equipAttack;
        }),
        equipItem: toNumberArray(record.eqpItm).filter(function (v) {
          return v !== null && v !== SENTINELS.equipItem;
        }),
        skills: decodeSkillGrid(record.getskill)
      });
    });
    return out;
  }

  function hexEntries(values, sentinel) {
    var out = [];
    (values || []).forEach(function (id, index) {
      if (id === null || id === sentinel) return;
      out.push({ index: index, id: id });
    });
    return out;
  }

  // Scenario order used by System Data's start/end arrays. The first eight are
  // the PS1 character block order, confirmed by both fixtures setting the index
  // of their own protagonist (Asellus 5, T260G 6). The ninth slot has no local
  // evidence and is only labelled by position.
  var SCENARIO_ORDER = ['Emelia', 'Lute', 'Red', 'Blue', 'Rouge', 'Asellus', 'T260G', 'Riki'];

  function scenarioName(index) {
    if (index < SCENARIO_ORDER.length) return SCENARIO_ORDER[index];
    return 'slot ' + (index + 1) + ' (unconfirmed)';
  }

  // systemData.shopRecordList is a fixed table of shop inventories: seventeen
  // Type entries, each with a stock list and a purchase count per item. The
  // stock lists are identical in every save (checked across both fixtures), so
  // only the counts move. This is the ledger behind the Shopaholic achievement.
  function extractShopRecords(list) {
    return Object.freeze((Array.isArray(list) ? list : []).map(function (shop) {
      var records = shop && Array.isArray(shop.ItemRecord) ? shop.ItemRecord : [];
      return Object.freeze({
        type: num(shop && shop.Type),
        items: Object.freeze(records.map(function (record) {
          return Object.freeze({
            id: num(record && record.ItemID),
            count: num(record && record.PurchaseItemCount)
          });
        }))
      });
    }));
  }

  // systemSaveData is one block per file, not per slot. sfSys is the PS1-style
  // system record; systemData carries profile counters and story flags.
  function extractSystem(block) {
    if (!block || typeof block !== 'object') return null;
    var sys = block.sfSys && typeof block.sfSys === 'object' ? block.sfSys : null;
    var flags = block.systemData && typeof block.systemData === 'object' ? block.systemData : null;
    if (!sys && !flags) return null;
    var sysObj = sys || {};
    var flagObj = flags || {};
    return Object.freeze({
      present: Boolean(sys),
      blood: num(sysObj.blood),
      zodiac: num(sysObj.seiza),
      learning: toNumberArray(sysObj.learning),
      parLev: num(sysObj.parLev),
      start: toNumberArray(sysObj.start),
      end: toNumberArray(sysObj.end),
      end2: toNumberArray(sysObj.end2),
      nameBytes: toNumberArray(sysObj.name),
      integrity: Object.freeze({
        chk: toNumberArray(sysObj.chk),
        chk2: toNumberArray(sysObj.chk2),
        chk3: toNumberArray(sysObj.chk3),
        chk4: toNumberArray(sysObj.chk4),
        sum: toNumberArray(sysObj.sum)
      }),
      counters: Object.freeze({
        kills: num(flagObj.totalKillNum),
        waza: num(flagObj.wazaUseCnt),
        jutsu: num(flagObj.jyutsuUseCnt),
        maxCombo: num(flagObj.maxComboNum),
        maxTurns: num(flagObj.maxTurnNum),
        damage: num(flagObj.totalDamage),
        goldSold: num(flagObj.goldSaleMoney)
      }),
      shopRecords: extractShopRecords(flagObj.shopRecordList)
    });
  }

  // Only the nonzero bytes carry information; the array is 512 long and most
  // entries are 0 in any real save.
  function extractScenarioFlags(values) {
    var out = [];
    toNumberArray(values).forEach(function (value, index) {
      if (value === null || value === 0) return;
      out.push({ index: index, value: value });
    });
    return out;
  }

  function buildViewModel(data, meta, systemSaveData) {
    var source = data || {};
    var pty = source.pty || {};
    var ply = Array.isArray(source.ply) ? source.ply : [];
    var itemList = Array.isArray(pty.item_a) ? pty.item_a : [];
    var eventwk = source.eventwk || {};
    var mapwk = source.mapwk || {};
    var scenarioFlagValues = toNumberArray(pty.snroFlg);
    var scenarioChartValues = toNumberArray(pty.scenarioChartStateArray);
    var chrNo = toNumberArray(pty.chrNo);
    var team = toNumberArray(pty.team);
    var companion = toNumberArray(pty.companionChrNo);

    return Object.freeze({
      meta: meta || null,
      party: {
        name: str(pty.name),
        count: num(pty.psnCnt),
        heroNo: num(pty.heroNo),
        team: team,
        chrNo: chrNo,
        companionChrNo: companion
      },
      money: num(pty.money),
      // The live encounter rank is pty.each.parLev; pty.parLev does not exist in
      // the Remastered payload and was the source of the old "-" in the party
      // card. The persisted scenario-clear record is sfSys.parLev, shown in the
      // System file card instead.
      encounterRank: num(pty.each && pty.each.parLev),
      items: extractItems(itemList),
      roster: extractRoster(ply),
      // Character ID arrays resolved against docs/constants.json.
      characterArrays: {
        chrNo: hexEntries(chrNo, SENTINELS.character),
        team: hexEntries(team, SENTINELS.character),
        companionChrNo: hexEntries(companion, SENTINELS.character)
      },
      location: {
        // The current room, from the IMF asset the map work area loaded.
        mapId: imfIdFromName(str(mapwk.imfName)),
        imfName: str(mapwk.imfName),
        // eventwk.mapNo is the previous map loaded (including cutscene maps),
        // not the current room. Kept and shown for reference, never as "the map".
        mapNo: num(eventwk.mapNo),
        x: num(eventwk.xpos),
        z: num(eventwk.zpos),
        dir: num(eventwk.dir),
        mapName: num(mapwk.map_name),
        regionNo: num(mapwk.region_no)
      },
      system: extractSystem(systemSaveData),
      scenarioFlags: extractScenarioFlags(scenarioFlagValues),
      scenarioFlagValues: scenarioFlagValues,
      scenarioChartValues: scenarioChartValues,
      counters: {
        scenarioChartSet: scenarioChartValues.reduce(function (acc, value) {
          return acc + (num(value) ? 1 : 0);
        }, 0),
        scenarioChartTotal: scenarioChartValues.length,
        scenarioFlagBytes: scenarioFlagValues.length,
        rosterCount: ply.length
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Name resolution
   * ------------------------------------------------------------------ */

  function makeResolver(constants, abilities, maps, flags, shops, itemStats, mysticAbsorbs, monsterForms) {
    var characters = (constants && constants.characters) || {};
    var items = (constants && constants.items) || {};
    var itemTable = (itemStats && itemStats.items) || {};
    var mysticTable = (mysticAbsorbs && mysticAbsorbs.enemies) || {};
    var monsterTable = (monsterForms && monsterForms.forms) || {};
    var monsterTargets = (monsterForms && Array.isArray(monsterForms.targets))
      ? monsterForms.targets
      : [];
    var mapTable = (maps && maps.maps) || {};
    var areaTable = (constants && constants.areas) || {};
    var flagTable = (flags && flags.flags) || {};
    var shopTable = (shops && shops.shops) || {};
    var abilityTable = (abilities && abilities.abilities) || {};
    var elementLegend = (abilities && abilities.meta && abilities.meta.element_legend) || {};
    var elementOrder = (abilities && abilities.meta && Array.isArray(abilities.meta.element_order))
      ? abilities.meta.element_order
      : Object.keys(elementLegend);
    var sectionList = (abilities && Array.isArray(abilities.sections)) ? abilities.sections : [];

    function toEntry(entry) {
      return {
        name: entry.name || null,
        status: entry.status || 'documented',
        note: entry.note || '',
        section: entry.section || null,
        elements: Array.isArray(entry.elements) ? entry.elements.slice() : []
      };
    }

    function lookup(table, id, keyFn) {
      var entry = table[(keyFn || hex2)(id)];
      if (!entry || typeof entry !== 'object') {
        return { name: null, status: 'unmapped', note: '', section: null, elements: [] };
      }
      return toEntry(entry);
    }

    return {
      character: function (id) { return lookup(characters, id); },
      item: function (id) { return lookup(items, id); },
      ability: function (id) { return lookup(abilityTable, id, hex4); },
      hasAbilities: function () { return Object.keys(abilityTable).length > 0; },
      map: function (id) {
        var name = mapTable[mapKey(id)];
        if (typeof name !== 'string' || !name) return { name: null, status: 'unmapped' };
        return { name: name, status: 'documented' };
      },
      hasMaps: function () { return Object.keys(mapTable).length > 0; },
      // mapwk.map_name and slot MapNumber index the game's 20-byte area table,
      // not the room table. constants.json carries it as `areas`.
      area: function (id) {
        var entry = areaTable[hex2(id)];
        if (!entry || typeof entry.name !== 'string' || !entry.name) {
          return { name: null, status: 'unmapped' };
        }
        return entry;
      },
      hasAreas: function () { return Object.keys(areaTable).length > 0; },
      elementLabel: function (code) { return elementLegend[code] || code; },
      elementLegend: function () { return elementLegend; },
      elementOrder: function () { return elementOrder; },
      sections: function () { return sectionList; },
      // Scenario flag bytes are keyed 0x000-0x1FF, three hex digits.
      flag: function (index) {
        var entry = flagTable[hex3(index)];
        if (!entry || typeof entry !== 'object') {
          return { label: null, entries: [], status: 'unmapped' };
        }
        return {
          label: typeof entry.label === 'string' ? entry.label : null,
          entries: Array.isArray(entry.entries) ? entry.entries : [],
          status: 'documented'
        };
      },
      hasFlags: function () { return Object.keys(flagTable).length > 0; },
      // A shop label is a location plus its stock, and the location is what the
      // Still to buy list groups by. The game has no shop-name table, so an
      // unmapped Type must fall back to its number and has no location.
      shop: function (type) {
        var entry = shopTable[String(type)];
        if (!entry || typeof entry !== 'object') {
          return { label: null, location: null, confidence: null, basis: null };
        }
        return {
          label: entry.label || null,
          location: entry.location || null,
          confidence: entry.confidence || null,
          basis: entry.basis || null
        };
      },
      hasShops: function () { return Object.keys(shopTable).length > 0; },
      // ITEMD03 rows. An id the table stops short of (0xF0-0xFF key items) or a
      // table that failed to load both answer known:false, so callers can tell
      // "no boost" from "no row" instead of adding a silent zero.
      itemStat: function (id) {
        var entry = itemTable[hex2(id)];
        var line = { known: Boolean(entry && typeof entry === 'object'), hp: 0 };
        STAT_FIELDS.forEach(function (field) { line[field.key] = 0; });
        if (!line.known) return line;
        line.hp = num(entry.hp) || 0;
        STAT_FIELDS.forEach(function (field) {
          line[field.key] = num(entry.stats && entry.stats[field.itemKey]) || 0;
        });
        return line;
      },
      hasItemStats: function () { return Object.keys(itemTable).length > 0; },
      // The save stores the absorbed enemy id, the stat mask and one amount per
      // weapon. This table supplies the name, the granted art and the guide's
      // normal/variant rows; an enemy outside it is reported as unknown rather
      // than dressed up as a name.
      mysticAbsorb: function (id) {
        var entry = mysticTable[hex2(id)];
        if (!entry || typeof entry !== 'object') {
          return { known: false, name: null, normal: {}, variants: {}, arts: {} };
        }
        return {
          known: true,
          name: entry.name || null,
          normal: entry.normal || {},
          variants: entry.variants || {},
          arts: entry.arts || {}
        };
      },
      hasMysticAbsorbs: function () { return Object.keys(mysticTable).length > 0; },
      // A Monster's form byte shares the enemy-id namespace, so the names come
      // from the same guide section as the Mystic rows. An id outside the table
      // is reported as unknown rather than dressed up as a form.
      monsterForm: function (id) {
        var entry = monsterTable[hex2(id)];
        if (!entry || typeof entry !== 'object') {
          return { known: false, name: null, variant: null };
        }
        return {
          known: true,
          name: entry.name || null,
          variant: entry.variant || null
        };
      },
      monsterTargetsFor: function (id) {
        var key = hex2(id);
        return monsterTargets.filter(function (target) {
          return target && target.form === key;
        });
      },
      hasMonsterForms: function () { return Object.keys(monsterTable).length > 0; }
    };
  }

  // A flag byte can be a state value or a set of independent bits. The source
  // mixes both forms, so the rule is: an exact state wins; otherwise every
  // single-bit entry whose bit is set. This is the rule recorded in
  // flag_names.json meta.match_rule, and it reproduces all six cross-checks.
  function matchFlagEntries(value, block) {
    var v = num(value);
    if (v === null || v === 0 || !block || !Array.isArray(block.entries)) return [];
    var exact = block.entries.filter(function (entry) {
      return entry.kind === 'state' && num(entry.value) === v;
    });
    if (exact.length) return exact;
    return block.entries.filter(function (entry) {
      var bit = num(entry.value);
      if (entry.kind !== 'bit' || bit === null || bit === 0) return false;
      if ((bit & (bit - 1)) !== 0) return false; // multi-bit entries are states
      return (v & bit) === bit;
    });
  }

  function displayName(resolved, id) {
    if (!resolved || resolved.status === 'unmapped') return 'Unmapped ' + hex2(id);
    if (!resolved.name) return 'Unknown ' + hex2(id);
    return resolved.name;
  }

  /* ------------------------------------------------------------------ *
   * Descriptor rendering
   *
   * Render functions build a plain descriptor tree rather than touching the
   * DOM directly. This keeps them pure (and testable outside a browser) and
   * avoids building markup strings from save data.
   * ------------------------------------------------------------------ */

  function h(tag, props) {
    var children = [];
    for (var i = 2; i < arguments.length; i++) pushChild(children, arguments[i]);
    return { tag: tag, props: props || {}, children: children };
  }

  function pushChild(target, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) {
      child.forEach(function (item) { pushChild(target, item); });
      return;
    }
    target.push(child);
  }

  function t(value) {
    return { text: String(value) };
  }

  function mapEntryName(id, resolver) {
    if (id === null || id === undefined || !resolver || !resolver.map) return null;
    return resolver.map(id).name;
  }

  function areaEntryName(id, resolver) {
    if (id === null || id === undefined || !resolver || !resolver.area) return null;
    return resolver.area(id).name;
  }

  // An id plus its name when the table has one. The raw id always stays visible:
  // an unnamed entry is a fact about the source, not a rendering failure, and a
  // missing table is a different state from a missing entry.
  function tableLabel(id, entry, hasTable, missingText) {
    var n = num(id);
    if (n === null) return '-';
    var suffix = (entry && entry.name) || (hasTable ? missingText : 'names unavailable');
    return [t(formatNumber(n) + '  '), h('span', {
      className: 'map-name' + (entry && entry.name ? '' : ' is-unmapped')
    }, suffix)];
  }

  function mapLabel(id, resolver) {
    var entry = id === null || id === undefined || !resolver || !resolver.map ? null : resolver.map(id);
    var hasTable = Boolean(resolver && typeof resolver.hasMaps === 'function' && resolver.hasMaps());
    return tableLabel(id, entry, hasTable, 'not in the map table');
  }

  function areaLabel(id, resolver) {
    var entry = id === null || id === undefined || !resolver || !resolver.area ? null : resolver.area(id);
    var hasTable = Boolean(resolver && typeof resolver.hasAreas === 'function' && resolver.hasAreas());
    return tableLabel(id, entry, hasTable, 'not in the area table');
  }

  function kv(label, value) {
    return [h('dt', null, label), h('dd', null, value)];
  }

  function statusBadge(resolved) {
    if (!resolved || resolved.status === 'verified') return null;
    if (['verified', 'asset', 'documented', 'ambiguous', 'unknown', 'placeholder', 'unmapped']
      .indexOf(resolved.status) === -1) return null;
    if (resolved.status === 'verified') return null;
    return h('span', {
      className: 'badge badge-' + resolved.status,
      title: resolved.note || 'Not verified against this save'
    }, resolved.status);
  }

  function nameWithBadge(resolved, id) {
    return [t(displayName(resolved, id)), statusBadge(resolved)];
  }

  function collectText(node, out) {
    out = out || [];
    if (node === null || node === undefined) return out;
    if (Array.isArray(node)) {
      node.forEach(function (child) { collectText(child, out); });
      return out;
    }
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node));
      return out;
    }
    if (node.text !== undefined) {
      out.push(String(node.text));
      return out;
    }
    (node.children || []).forEach(function (child) { collectText(child, out); });
    return out;
  }

  // The room name is the specific one and usually already names its area. When
  // the room table has a hole but the area table does not, the area is still a
  // true, useful label; only when both miss does the line say so.
  function slotPlaceName(slot, resolver) {
    return mapEntryName(slot.mapId, resolver) || areaEntryName(slot.mapNumber, resolver);
  }

  // The visible line is one name; the title carries both ids so neither the area
  // nor the room is lost when they disagree.
  function slotTitle(slot, resolver) {
    var parts = [];
    var hasAreas = Boolean(resolver && typeof resolver.hasAreas === 'function' && resolver.hasAreas());
    var hasMaps = Boolean(resolver && typeof resolver.hasMaps === 'function' && resolver.hasMaps());
    if (slot.mapNumber !== null) {
      parts.push('Area ' + formatNumber(slot.mapNumber) + ': ' +
        (areaEntryName(slot.mapNumber, resolver) ||
          (hasAreas ? 'no name in the area table' : 'area names unavailable')));
    }
    if (slot.mapId !== null) {
      parts.push('Map ' + formatNumber(slot.mapId) + ': ' +
        (mapEntryName(slot.mapId, resolver) ||
          (hasMaps ? 'no name in the map table' : 'map names unavailable')));
    }
    return parts.length ? parts.join(' - ') : null;
  }

  // The slot picker shows one page of three at a time. Paging is presentational:
  // the full picker stays mounted and off-page rows are hidden, so a selection,
  // a drop or a test never loses the entries outside the current page.
  function slotPageBounds(total, page) {
    var count = Math.max(0, Number(total) || 0);
    var pages = Math.max(1, Math.ceil(count / SLOT_PAGE_SIZE));
    var safe = Math.min(Math.max(0, page || 0), pages - 1);
    var start = safe * SLOT_PAGE_SIZE;
    return {
      page: safe,
      pages: pages,
      start: start,
      end: Math.min(start + SLOT_PAGE_SIZE, count),
      total: count
    };
  }

  // The populated-only filter narrows what the pager walks over without
  // touching state.slots, so clearing the filter restores every entry.
  function slotsForFilter(slots, populatedOnly) {
    var all = slots || [];
    return populatedOnly ? all.filter(function (slot) { return slot.hasData; }) : all;
  }

  // Quick and Auto are the newest saves but sit at the end of a 61-entry list.
  // These two compact buttons keep them one click away on every page, and stay
  // put when the populated-only filter hides empty slot rows.
  function buildFastSlots(slots, selectedKey, onSelect, resolver) {
    var fast = (slots || []).filter(function (slot) {
      return slot.kind === 'quick' || slot.kind === 'auto';
    });
    if (fast.length === 0) return null;
    return h('div', { className: 'slot-fast-row' }, fast.map(function (slot) {
      var kind = slot.kind === 'quick' ? 'Quick' : 'Auto';
      var label = slot.characterName || (slot.hasData ? 'Unnamed' : 'Empty');
      return h('button', {
        type: 'button',
        className: 'slot-fast-button' + (slot.key === selectedKey ? ' is-selected' : ''),
        disabled: !slot.hasData,
        'aria-pressed': slot.key === selectedKey ? 'true' : 'false',
        'aria-label': 'Open ' + kind + ' save' + (slot.hasData ? ': ' + label : ' (empty)'),
        title: slot.hasData ? slotTitle(slot, resolver) : null,
        onClick: function () { onSelect(slot); }
      },
        h('span', { className: 'slot-fast-kind' }, kind),
        h('span', { className: 'slot-fast-name' }, label)
      );
    }));
  }

  function buildSlotPicker(slots, selectedKey, onSelect, resolver) {
    var visible = slots || [];
    if (visible.length === 0) {
      return h('p', { className: 'empty' }, 'No slots available.');
    }
    return h('ul', { className: 'slots' }, visible.map(function (slot) {
      var label = slot.characterName || (slot.hasData ? 'Unnamed' : 'Empty');
      var classes = ['slot'];
      if (slot.isEmpty) classes.push('is-empty');
      if (slot.key === selectedKey) classes.push('is-selected');
      return h('li', { key: slot.key },
        h('button', {
          type: 'button',
          className: classes.join(' '),
          disabled: !slot.hasData,
          'aria-pressed': slot.key === selectedKey ? 'true' : 'false',
          title: slot.hasData ? slotTitle(slot, resolver) : null,
          onClick: function () { onSelect(slot); }
        },
          h('span', { className: 'slot-index' },
            slot.kind === 'slot' ? 'Slot ' + slot.index : (slot.kind === 'quick' ? 'Quick' : 'Auto')),
          h('span', { className: 'slot-name' }, label),
          h('span', { className: 'slot-meta' },
            (slot.mapId === null ? 'map -' : 'map ' + formatNumber(slot.mapId)) +
            ' / ' + formatPlayTime(slot.hours, slot.minutes)),
          // The meta line has no room for a name, so the area gets its own line,
          // clamped by CSS and complete in the button's title. The room name is
          // longer and would push the row out of shape; it stays in the title.
          slot.hasData ? h('span', {
            className: 'slot-map' + (slotPlaceName(slot, resolver) ? '' : ' is-unmapped')
          }, slotPlaceName(slot, resolver) || 'unnamed map') : null
        )
      );
    }));
  }

  function buildFileInfo(fileName, byteLength, sha256, unchanged, payloadBytes, containerKind) {
    var rows = [
      kv('File', fileName || '-'),
      kv('Size', formatNumber(byteLength) + ' bytes')
    ];
    if (containerKind) {
      rows.push(kv('Container', containerKind === 'deflate-raw'
        ? 'raw DEFLATE (RFC 1951) - inflated on load'
        : 'JSON text'));
    }
    if (payloadBytes !== undefined && payloadBytes !== null && payloadBytes !== byteLength) {
      rows.push(kv('Inflated payload', formatNumber(payloadBytes) + ' bytes'));
    }
    rows.push(
      kv('SHA-256 of original', sha256 ? h('code', { className: 'mono' }, sha256) : 'unavailable'),
      kv('Original buffer intact', unchanged === null ? 'not checked' : (unchanged ? 'yes' : 'NO - investigate'))
    );
    return h('dl', { className: 'kv kv-inline' }, rows);
  }

  function hexTable(rows) {
    return h('table', { className: 'grid grid-hex' },
      h('thead', null, h('tr', null,
        h('th', null, 'Offset'),
        h('th', null, 'Bytes'),
        h('th', null, 'ASCII')
      )),
      h('tbody', null, rows.map(function (row) {
        return h('tr', null,
          h('td', { className: 'mono', 'data-label': 'Offset' }, hex2(row.offset)),
          h('td', { className: 'mono hex-bytes', 'data-label': 'Bytes' }, row.hex),
          h('td', { className: 'mono hex-ascii', 'data-label': 'ASCII' }, row.ascii)
        );
      }))
    );
  }

  function buildByteInspector(inspection) {
    if (!inspection) {
      return h('p', { className: 'empty' }, 'No byte inspection available.');
    }
    var markerText = inspection.markerOffset === -1
      ? 'not found'
      : 'first at byte ' + formatNumber(inspection.markerOffset) +
        ', ' + formatNumber(inspection.markerCount) + ' occurrence(s)';

    var compressed = inspection.containerKind === 'deflate-raw';
    return h('div', null,
      h('p', { className: 'hint' },
        compressed
          ? 'DataView reads the raw container bytes below; the JSON payload is inflated first. ' +
            'Offsets are diagnostic only: character and item values are resolved from the parsed ' +
            'structure, not from byte positions.'
          : 'DataView reads the raw bytes below. This save is JSON text, so these offsets are ' +
            'diagnostic only: character and item values are resolved from the parsed structure, ' +
            'not from byte positions.'),
      h('dl', { className: 'kv' },
        kv('Container', compressed ? 'raw DEFLATE (RFC 1951)' : 'JSON text'),
        kv('Bytes on disk', formatNumber(inspection.byteLength)),
        kv('Payload bytes', formatNumber(inspection.payloadByteLength)),
        kv('Characters (UTF-8)', formatNumber(inspection.textLength)),
        kv('UTF-8 BOM', inspection.hasUtf8Bom ? 'yes' : 'no'),
        kv('Leading byte', inspection.leadingByte === null
          ? '-'
          : hex2(inspection.leadingByte) + " ('" + inspection.leadingChar + "')"),
        kv('Looks like JSON container', inspection.looksLikeJson ? 'yes' : 'no'),
        kv('Slot blob marker', markerText),
        kv('First 16 bytes', h('code', { className: 'mono' }, inspection.firstBytesHex)),
        kv('Last 16 bytes', h('code', { className: 'mono' }, inspection.lastBytesHex))
      ),
      h('h3', null, 'Hex dump (first 256 bytes)'),
      h('div', { className: 'table-scroll' }, hexTable(inspection.rows)),
      buildRoundTripReport(inspection.roundTrip)
    );
  }

  function buildRoundTripReport(report) {
    if (!report) return null;

    var rows = [
      kv('Container', report.containerKind === 'deflate-raw'
        ? 'raw DEFLATE (proof covers the inflated payload)'
        : 'JSON text'),
      kv('Byte-exact passthrough (no edits)', report.passthroughExact ? 'yes' : 'no'),
      kv('Container re-serialize byte-exact', report.outerExact ? 'yes' : 'no')
    ];

    if (report.containerKind === 'deflate-raw') {
      rows.push(kv('Recompression', 'not attempted - no zlib setting reproduces the game stream'));
    }

    if (!report.outerExact && report.outerFirstDiff) {
      rows.push(kv('First divergence',
        'character ' + report.outerFirstDiff.index + ': ' +
        JSON.stringify(report.outerFirstDiff.original) + ' becomes ' +
        JSON.stringify(report.outerFirstDiff.reserialized)));
    }

    if (report.innerExact !== null) {
      rows.push(kv('Slot blob re-serialize byte-exact', report.innerExact ? 'yes' : 'no'));
    }

    rows.push(kv('No-op write reproduces the original', report.noOpWriteExact ? 'yes' : 'no'));

    if (report.edit) {
      if (report.edit.error) {
        rows.push(kv('Dry-run edit', 'failed: ' + report.edit.error));
      } else {
        rows.push(kv('Dry-run edit (' + report.edit.path + ')',
          report.edit.from + ' -> ' + report.edit.to + ', applied: ' + (report.edit.reapplied ? 'yes' : 'no')));
        rows.push(kv('Bytes touched by that edit',
          report.edit.region.changedInOriginal + ' replaced, ' + report.edit.region.changedInOutput +
          ' written, file delta ' + report.edit.lengthDelta));
      }
    }

    return h('div', { className: 'round-trip' },
      h('h3', null, 'Round-trip proof'),
      h('p', { className: 'hint' },
        'No file is written by this page. Edits are built by splicing only the changed span, ' +
        'because re-serializing the container rewrites decimals such as 1.0 as 1 and shortens the file. ' +
        'The dry-run row shows exactly which bytes a single-field edit would touch.'),
      h('dl', { className: 'kv' }, rows)
    );
  }

  function buildCharacterArrays(vm, resolver) {
    var groups = [
      { source: 'chrNo', label: 'chrNo (roster order)', entries: vm.characterArrays.chrNo },
      { source: 'team', label: 'team (active order)', entries: vm.characterArrays.team },
      { source: 'companionChrNo', label: 'companionChrNo', entries: vm.characterArrays.companionChrNo }
    ];

    var body = [];
    groups.forEach(function (group) {
      group.entries.forEach(function (entry) {
        body.push(h('tr', null,
          h('td', { className: 'mono' }, group.source),
          h('td', { className: 'num' }, String(entry.index)),
          h('td', { className: 'mono' }, hex2(entry.id)),
          h('td', null, nameWithBadge(resolver.character(entry.id), entry.id))
        ));
      });
    });

    return h('section', { className: 'card card-wide', id: 'character-arrays', 'data-index-label': 'Character arrays' },
      h('h3', null, 'Character hex array'),
      h('p', { className: 'hint' },
        'IDs resolved against docs/constants.json. Sentinel 0xFF entries are omitted.'),
      body.length
        ? h('div', { className: 'table-scroll' },
            h('table', { className: 'grid grid-character' },
              h('thead', null, h('tr', null,
                h('th', null, 'Array'),
                h('th', null, 'Index'),
                h('th', null, 'Hex'),
                h('th', null, 'Name')
              )),
              h('tbody', null, body)
            )
          )
        : h('p', { className: 'empty' }, 'No populated character slots.')
    );
  }

  // Gifts bitfield (record byte 0x15) and Race/Gender byte (0x16), both per the
  // community data project. Documented, not extracted from the game's assets.
  var GIFT_BITS = [
    { mask: 0x80, name: 'Rune' },
    { mask: 0x40, name: 'Arcane' },
    { mask: 0x20, name: 'Evil' },
    { mask: 0x10, name: 'Mind' },
    { mask: 0x08, name: 'Mystic' },
    { mask: 0x04, name: 'Realm' },
    { mask: 0x02, name: 'Shadow' },
    { mask: 0x01, name: 'Light' }
  ];

  var RACE_LABELS = {
    0x41: 'Human Female',
    0x81: 'Human Male',
    0x42: 'Mystic Female',
    0x82: 'Mystic Male',
    0x04: 'Mec',
    0x08: 'Monster',
    0x98: 'Monster (bits 4 and 7 also set)'
  };

  var MEC_RACE = 0x04;

  // Mystic race codes and the three weapon arts that carry an absorb. The
  // absorbed monster itself is NOT in eqpAtk: slots 4-6 hold these base arts,
  // and tribial_work.data[4..12] holds the three enemy/mask/amount triples.
  var MYSTIC_RACES = [0x42, 0x82];
  var MYSTIC_WEAPONS = [
    { key: 'sword', label: 'Sword', artId: 432, code: '0x1B0' },
    { key: 'glove', label: 'Glove', artId: 448, code: '0x1C0' },
    { key: 'boots', label: 'Boots', artId: 464, code: '0x1D0' }
  ];

  // The eight body types the game's own name table carries (BaccaratTblData.bin,
  // 12 bytes each at 0xD396). TYPE1-TYPE7 belong to a recruitable Mec; TYPE8 is
  // in the table but no PC starts on it.
  var MEC_BODY_TYPES = ['TYPE1', 'TYPE2', 'TYPE3', 'TYPE4', 'TYPE5', 'TYPE6', 'TYPE7', 'TYPE8'];

  // The record's seven live stat fields, in the documented order. The payload's
  // own names (dexNow, hndNow, mndNow, mgcNow, conNow) are historical: the
  // community charts and the game's INIT tables call these Quickness,
  // Intelligence, Will, Psychic and Vitality. itemKey is the spelling the
  // Mec item chart uses, so both sides meet in one list.
  var STAT_FIELDS = [
    { key: 'str', itemKey: 'str', code: 'STR', name: 'Strength' },
    { key: 'dex', itemKey: 'qui', code: 'QUI', name: 'Quickness' },
    { key: 'hnd', itemKey: 'int', code: 'INT', name: 'Intelligence' },
    { key: 'mnd', itemKey: 'wil', code: 'WIL', name: 'Will' },
    { key: 'mgc', itemKey: 'psy', code: 'PSY', name: 'Psychic' },
    { key: 'con', itemKey: 'vit', code: 'VIT', name: 'Vitality' },
    { key: 'chm', itemKey: 'cha', code: 'CHA', name: 'Charm' }
  ];

  function decodeGifts(nature) {
    var value = num(nature);
    if (value === null) return { raw: null, gifts: [], undecoded: 0 };
    var gifts = GIFT_BITS.filter(function (bit) {
      return (value & bit.mask) !== 0;
    });
    var covered = gifts.reduce(function (acc, bit) { return acc | bit.mask; }, 0);
    return { raw: value, gifts: gifts, undecoded: value & ~covered };
  }

  function raceLabel(race) {
    var value = num(race);
    if (value === null) return { raw: null, label: null };
    return { raw: value, label: RACE_LABELS[value] || null };
  }

  // pty.each.parLev is the packed Battle Rank Points byte, not a scaled level:
  // BR-1 sits in the high nibble and the points toward the next rank (0-15) in
  // the low nibble, so 0x17 is BR 2 with 7 points. The Data Mechanics Guide
  // documents the 16:1 scale in its BRP patch notes ("x: your BR minus 1",
  // "y: points towards the next BR"). No save here carries a known in-game BR
  // yet, so this is documented, not observed.
  function battleRankFromParLev(value) {
    var n = num(value);
    if (n === null || n < 0) return null;
    return { rank: Math.floor(n / 16) + 1, points: n % 16 };
  }

  function encounterRankLabel(value) {
    var n = num(value);
    var br = battleRankFromParLev(n);
    if (n === null || !br) return '-';
    if (br.rank >= 9) {
      return [t(formatNumber(n) + '  '), h('span', { className: 'rank-note' },
        'BR 9, ' + formatNumber(br.points) + '/13 toward resetting to BR 8')];
    }
    return [t(formatNumber(n) + '  '), h('span', { className: 'rank-note' },
      'BR ' + formatNumber(br.rank) + ', ' + formatNumber(br.points) +
      '/16 toward BR ' + formatNumber(br.rank + 1))];
  }

  // INIT selection, from the documented rule (Data Mechanics Guide [INITD01]):
  // the set is chosen by the Battle Rank at which the last completed scenario was
  // saved - BR 1-3 -> INIT 2, 4-6 -> INIT 3, 7-9 -> INIT 4 - and no completed
  // scenario means INIT 1. parLev is the packed BRP byte (16 per rank), so those
  // brackets are parLev 0-47, 48-95 and 96-143. The packing is documented; no
  // save with a completed scenario has been observed, so the boundary is not
  // confirmed. hasCompletedScenario comes from the end/end2 records, because a
  // clear at BR 1 with 0 points also stores parLev 0.
  function predictInit(parLev, hasCompletedScenario) {
    var n = num(parLev);
    if (n === null) return null;
    if (!hasCompletedScenario) return { set: '1', range: 'no completed scenario' };
    var br = battleRankFromParLev(n);
    if (br.rank <= 3) return { set: '2', range: 'BR ' + br.rank + ' (parLev ' + n + ')' };
    if (br.rank <= 6) return { set: '3', range: 'BR ' + br.rank + ' (parLev ' + n + ')' };
    return { set: '4', range: 'BR ' + br.rank + ' (parLev ' + n + ')' };
  }

  function hasCompletedScenario(system) {
    if (!system) return false;
    var ended = (system.end || []).some(function (value) { return Boolean(num(value)); });
    var trueEnded = (system.end2 || []).some(function (value) { return Boolean(num(value)); });
    return ended || trueEnded;
  }

  function systemClearRankLabel(system) {
    var n = num(system && system.parLev);
    var br = battleRankFromParLev(n);
    if (n === null || !br) return '-';
    var note = hasCompletedScenario(system)
      ? 'BR ' + formatNumber(br.rank) + ', ' + formatNumber(br.points) + '/16 points at the last clear'
      : 'no scenario completed';
    return [t(formatNumber(n) + '  '), h('span', { className: 'rank-note' }, note)];
  }

  // Questionnaire answers and other unlabelled system bytes: show the number and
  // an honest note rather than inventing a name for it.
  function systemValueLabel(value, note) {
    var n = num(value);
    if (n === null) return '-';
    return [t(formatNumber(n) + '  '), h('span', { className: 'rank-note' }, note)];
  }

  function startedScenarioNames(system) {
    if (!system || !system.start) return [];
    var names = [];
    system.start.forEach(function (value, index) {
      if (num(value)) names.push(scenarioName(index));
    });
    return names;
  }

  function formatByteList(values) {
    if (!values || !values.length) return '-';
    return values.map(function (value) {
      return value === null || value === undefined ? '??' : hexByte(value);
    }).join(' ');
  }

  var ABILITY_SECTION_LABELS = {
    sword: 'Sword',
    gun: 'Gun',
    fighting: 'Fighting',
    magic: 'Magic',
    dodge_mec: 'Dodge / Mec',
    mystic_enemy: 'Mystic / Enemy',
    monster: 'Monster abilities',
    enemy: 'Enemy abilities'
  };

  function joinResolved(entries, resolver, key) {
    if (!entries.length) return '-';
    return entries.map(function (entry) {
      return displayName(resolver[key](entry.id), entry.id);
    }).join(', ');
  }

  function groupLearned(learned) {
    var groups = {};
    var order = [];
    learned.forEach(function (entry) {
      var key = entry.resolved.section || 'other';
      if (!groups[key]) {
        groups[key] = [];
        order.push(key);
      }
      groups[key].push(entry);
    });
    return order.map(function (key) {
      return { key: key, entries: groups[key] };
    });
  }

  function elementFlags(codes, resolver) {
    var list = codes || [];
    if (!list.length) return h('span', { className: 'element-flags empty-flags' }, 'no element');
    return h('span', { className: 'element-flags' }, list.map(function (code) {
      return h('span', {
        className: 'element-flag',
        title: resolver && resolver.elementLabel ? resolver.elementLabel(code) : code
      }, code);
    }));
  }

  function abilityListItem(entry, resolver) {
    return h('li', { className: 'detail-ability' },
      h('span', { className: 'ability-name' }, nameWithBadge(entry.resolved, entry.id)),
      elementFlags(entry.resolved.elements, resolver)
    );
  }

  /* ------------------------------------------------------------------ *
   * Mec body profile
   *
   * A Mec's record holds the body's base values; its parts occupy the same
   * eight equipment slots every character has, and the game adds the parts'
   * stat boosts on top. That is why the Data Mechanics Guide prints Mec INIT
   * stats as "Base + boost" (T260: HP 100 + 25, STR 5 + 11). Base plus the
   * ITEMD03 boosts is therefore the character's effective total, which the
   * guide prints but the save does not store.
   * ------------------------------------------------------------------ */

  function zeroStatLine() {
    var line = { hp: 0 };
    STAT_FIELDS.forEach(function (field) { line[field.key] = 0; });
    return line;
  }

  function addStatLine(target, entry) {
    target.hp += entry.hp || 0;
    STAT_FIELDS.forEach(function (field) {
      target[field.key] += entry[field.key] || 0;
    });
    return target;
  }

  function buildMecProfile(record, resolver) {
    if (!record || num(record.race) !== MEC_RACE) return null;

    var scratch = toNumberArray(record.tribialWork || []);
    var bodyIndex = scratch.length ? num(scratch[0]) : null;

    var base = { hp: num(record.hpMax) };
    STAT_FIELDS.forEach(function (field) {
      base[field.key] = record.stats ? num(record.stats[field.key]) : null;
    });

    var boost = zeroStatLine();
    var parts = [];
    var unmapped = 0;

    (record.equipItem || []).forEach(function (id) {
      var item = resolver && typeof resolver.itemStat === 'function' ? resolver.itemStat(id) : null;
      if (!item || !item.known) {
        // Keep the slot so the count matches the eight eqpItm slots, but never
        // treat a missing row as a zero boost.
        unmapped++;
        parts.push({ id: id, known: false, boost: zeroStatLine() });
        return;
      }
      var line = { hp: item.hp };
      STAT_FIELDS.forEach(function (field) { line[field.key] = item[field.key]; });
      addStatLine(boost, line);
      parts.push({ id: id, known: true, boost: line });
    });

    var total = { hp: base.hp === null ? null : base.hp + boost.hp };
    STAT_FIELDS.forEach(function (field) {
      total[field.key] = base[field.key] === null ? null : base[field.key] + boost[field.key];
    });

    return {
      race: MEC_RACE,
      bodyIndex: bodyIndex,
      // An index outside the eight names is reported as unknown, not guessed.
      bodyName: bodyIndex !== null && MEC_BODY_TYPES[bodyIndex]
        ? MEC_BODY_TYPES[bodyIndex]
        : null,
      base: base,
      boost: boost,
      total: total,
      parts: parts,
      unmappedParts: unmapped
    };
  }

  // "+20 HP, +5 STR" for one part. Empty slots and items with no row in the
  // chart say so rather than printing a bare zero.
  function statBoostText(line) {
    var out = [];
    if (line.hp) out.push('+' + formatNumber(line.hp) + ' HP');
    STAT_FIELDS.forEach(function (field) {
      if (line[field.key]) out.push('+' + formatNumber(line[field.key]) + ' ' + field.code);
    });
    return out.length ? out.join(', ') : 'no stat boost';
  }

  function buildMecProfileBlock(profile, options) {
    if (!profile) return null;
    options = options || {};

    var rows = [{ code: 'HP', name: 'Hit Points', key: 'hp' }].concat(STAT_FIELDS);
    // The body TYPE is the only player-facing part of tribial_work. Its raw
    // array index stays out of the card; an index the name table lacks is
    // reported as such instead of being dressed up as a type.
    var body = profile.bodyName
      ? t(profile.bodyName)
      : t(profile.bodyIndex === null
          ? 'not in the record'
          : 'index ' + formatNumber(profile.bodyIndex) + ' has no name');

    var partsNote = countLabel(profile.parts.length, 'part', 'parts');
    if (profile.unmappedParts) {
      partsNote += ', ' + formatNumber(profile.unmappedParts) +
        ' with no row in the item table';
    }

    return h('div', { className: 'detail-block mec-profile' },
      h('h4', null, 'Mec body  ', h('span', { className: 'count' }, 'race 0x04')),
      h('dl', { className: 'kv' },
        kv('Body type', body),
        kv('Parts', partsNote)
      ),
      h('div', { className: 'table-scroll' },
        h('table', { className: 'grid grid-mec' },
          h('thead', null, h('tr', null,
            h('th', null, 'Stat'),
            h('th', null, 'Base'),
            h('th', null, 'Parts'),
            h('th', null, 'With parts')
          )),
          h('tbody', null, rows.map(function (row) {
            return h('tr', null,
              h('td', null, row.code, h('span', { className: 'mec-stat-name' }, ' ' + row.name)),
              h('td', { className: 'num' }, formatNumber(profile.base[row.key])),
              h('td', { className: 'num' }, profile.boost[row.key]
                ? '+' + formatNumber(profile.boost[row.key])
                : '-'),
              h('td', { className: 'num' }, formatNumber(profile.total[row.key]))
            );
          }))
        )
      ),
      options.itemStatsError
        ? h('p', { className: 'hint' }, options.itemStatsError +
            '. The parts column is incomplete.')
        : null,
      h('p', { className: 'hint' },
        'Base is the value stored in the record. Parts is the sum of the eight eqpItm ' +
        'slots resolved against the Mec column of the Data Mechanics Guide item chart ' +
        '(ITEMD03), and With parts is their sum. The guide prints the same layout: ' +
        'T260 is HP 100 + 25 and STR 5 + 11 at scenario start. These are not values ' +
        'the save stores; they are the base-plus-parts total the INIT tables print.')
    );
  }

  function sameStatLine(a, b) {
    var left = a || {};
    var right = b || {};
    var keys = Object.keys(left).filter(function (key) { return left[key]; });
    var others = Object.keys(right).filter(function (key) { return right[key]; });
    if (keys.length !== others.length) return false;
    return keys.every(function (key) { return left[key] === right[key]; });
  }

  function mysticBoostText(boosts) {
    return boosts.length
      ? boosts.map(function (boost) {
          return boost.code + ' +' + formatNumber(boost.value);
        }).join(', ')
      : 'no stat boost';
  }

  function mysticNormalText(stats) {
    var out = [];
    STAT_FIELDS.forEach(function (field) {
      if (stats && stats[field.itemKey]) {
        out.push(field.code + ' +' + formatNumber(stats[field.itemKey]));
      }
    });
    return out.length ? out.join(', ') : 'none';
  }

  // A Mystic's three weapon absorbs live in tribial_work.data[4..12], not in
  // eqpAtk. The gate is the Mystic race, any of the three weapon arts, or a
  // stored absorb; a Human with the Mystic gift (Asellus in her own scenario)
  // has none of those and gets a note instead of an empty panel.
  function buildMysticAbsorbs(record, resolver) {
    if (!record) return null;
    var scratch = toNumberArray(record.tribialWork || []);
    var arts = record.equipAttack || [];
    var race = num(record.race);
    var isMysticRace = MYSTIC_RACES.indexOf(race) !== -1;

    var rows = MYSTIC_WEAPONS.map(function (weapon, index) {
      var enemyId = scratch.length > 4 + index ? num(scratch[4 + index]) : null;
      var mask = scratch.length > 7 + index ? num(scratch[7 + index]) : null;
      var amount = scratch.length > 10 + index ? num(scratch[10 + index]) : null;
      // A Monster's scratch block is zero-filled, not 0xFF-filled: Riki's INIT
      // record carries an enemy id of 0 and no mask or amount. A recorded
      // absorb always has both a stat bit and a nonzero amount, so a zero
      // triple means "nothing stored", not enemy 0x00 (Rocky).
      var empty = enemyId === null || enemyId === 255 ||
        mask === null || mask === 0 || amount === null || amount === 0;
      var resolved = empty || !resolver || typeof resolver.mysticAbsorb !== 'function'
        ? { known: false, name: null, normal: {}, variants: {}, arts: {} }
        : resolver.mysticAbsorb(enemyId);

      var stored = {};
      var boosts = [];
      STAT_FIELDS.forEach(function (field, bit) {
        if (mask !== null && amount !== null && amount > 0 && (mask & (1 << bit)) !== 0) {
          stored[field.itemKey] = amount;
          boosts.push({ code: field.code, value: amount });
        }
      });

      // The save stores the result of an INIT or Possession override, so match
      // the stored mask/amount against the normal row and then each documented
      // variant. Never guess which variant applied.
      var variantName = null;
      if (!empty && resolved.known) {
        if (!sameStatLine(stored, resolved.normal)) {
          Object.keys(resolved.variants || {}).forEach(function (label) {
            if (variantName === null && sameStatLine(stored, resolved.variants[label])) {
              variantName = label;
            }
          });
          if (variantName === null) variantName = 'unlisted variant';
        }
      }

      return {
        key: weapon.key,
        label: weapon.label,
        artId: weapon.artId,
        code: weapon.code,
        weaponKnown: arts.indexOf(weapon.artId) !== -1,
        enemyId: enemyId,
        mask: mask,
        amount: amount,
        empty: empty,
        known: resolved.known,
        name: resolved.name || null,
        normal: resolved.normal || {},
        stored: stored,
        boosts: boosts,
        variantName: variantName,
        grant: (resolved.arts || {})[weapon.key] || null
      };
    });

    var hasData = rows.some(function (row) { return !row.empty; });
    var knownWeapon = MYSTIC_WEAPONS.some(function (weapon) {
      return arts.indexOf(weapon.artId) !== -1;
    });
    if (!isMysticRace && !knownWeapon && !hasData) return null;

    return { race: race, isMysticRace: isMysticRace, rows: rows };
  }

  function buildMysticAbsorbBlock(profile, options) {
    if (!profile) return null;
    options = options || {};

    var entries = profile.rows.map(function (row) {
      var tags = [];
      if (!row.weaponKnown) {
        tags.push(h('span', {
          className: 'chip chip-unknown',
          title: 'This record does not know the ' + row.label + ' Mystic weapon art'
        }, 'weapon not known'));
      }
      if (row.variantName) {
        tags.push(h('span', {
          className: 'chip' + (row.variantName === 'unlisted variant' ? ' chip-unknown' : ''),
          title: 'Documented INIT or Possession override'
        }, row.variantName));
      }

      var head = row.empty
        ? [t('none')]
        : [t((row.name || 'Enemy ' + hex2(row.enemyId)) + '  '),
           h('span', { className: 'mono' }, hex2(row.enemyId))];

      var lines = row.empty
        ? [h('span', { className: 'mystic-line' }, 'no absorb stored')]
        : [
            h('span', { className: 'mystic-line' }, 'Boosts: ' + mysticBoostText(row.boosts)),
            row.variantName
              ? h('span', { className: 'mystic-line' }, 'Guide normal: ' + mysticNormalText(row.normal))
              : null,
            h('span', { className: 'mystic-line' },
              'Grants: ',
              row.grant
                ? [t(row.grant.name + '  '), h('span', { className: 'mono' }, hex4(row.grant.id))]
                : t('-'))
          ];

      return kv(row.label, h('span', { className: 'mystic-value' },
        h('span', { className: 'mystic-head' },
          head,
          tags.length ? h('span', { className: 'chips' }, tags) : null),
        lines
      ));
    });

    return h('div', { className: 'detail-block mystic-absorbs' },
      h('h4', null, 'Mystic absorbs  ', h('span', { className: 'count' }, '3 weapons')),
      h('dl', { className: 'kv' }, entries),
      options.mysticAbsorbError
        ? h('p', { className: 'hint' }, options.mysticAbsorbError +
            '. Enemy names and granted arts stay hidden until that table loads.')
        : null,
      h('p', { className: 'hint' },
        'Stored boosts are read from this save. Enemy names, granted arts and the named variant rows are documented data from the Data Mechanics Guide. ' +
        'Layout verified: all 12 INIT weapon slots for Ildon, Zozma, Rei and Silence decode to the guide\'s enemy, mask and amount.')
    );
  }

  // A Monster's current form is tribial_work.data[0]. The record stores the
  // form's base HP in hpMax; Prime HP is four points per distinct monster
  // ability the character has absorbed (the 128-bit block at ids 128-255).
  function buildMonsterForm(record, resolver) {
    if (!record) return null;
    var race = num(record.race);
    if (MONSTER_RACES.indexOf(race) === -1) return null;

    var scratch = toNumberArray(record.tribialWork || []);
    var formId = scratch.length ? num(scratch[0]) : null;
    var form = formId === null || !resolver || typeof resolver.monsterForm !== 'function'
      ? { known: false, name: null, variant: null }
      : resolver.monsterForm(formId);
    var absorbed = (record.skills || []).filter(function (entry) {
      return entry.abilityId >= MONSTER_ABILITY_LOW && entry.abilityId <= MONSTER_ABILITY_HIGH;
    });
    var targets = formId === null || !resolver || typeof resolver.monsterTargetsFor !== 'function'
      ? []
      : resolver.monsterTargetsFor(formId);

    var baseHp = num(record.hpMax);
    var primeHp = absorbed.length * PRIME_HP_PER_ABILITY;
    return {
      race: race,
      formId: formId,
      known: form.known,
      name: form.name,
      variant: form.variant,
      baseHp: baseHp,
      absorbedCount: absorbed.length,
      primeHp: primeHp,
      maxHp: baseHp === null ? null : baseHp + primeHp,
      targets: targets
    };
  }

  function monsterRequirementText(ids, resolver) {
    return (ids || []).map(function (id) {
      var value = parseInt(id, 16);
      var resolved = resolver && typeof resolver.ability === 'function'
        ? resolver.ability(value)
        : { name: null };
      return resolved.name || hex2(value);
    }).join(', ');
  }

  function monsterTargetLines(target, resolver) {
    if (target.table === 1) {
      return [h('span', { className: 'monster-line' },
        'Requires all of ' + monsterRequirementText(target.requires && target.requires.all, resolver) + '.')];
    }
    var lines = [];
    Object.keys(MONSTER_CATEGORY_LABELS).forEach(function (key) {
      var ids = target.requires && target.requires[key];
      if (!ids || !ids.length) return;
      lines.push(h('span', { className: 'monster-line' },
        MONSTER_CATEGORY_LABELS[key] + ': any of ' + monsterRequirementText(ids, resolver) + '.'));
    });
    return lines;
  }

  function buildMonsterFormBlock(profile, options) {
    if (!profile) return null;
    options = options || {};

    var formHead;
    if (profile.known && profile.name) {
      formHead = [t(profile.name + '  '), h('span', { className: 'mono' }, hex2(profile.formId))];
      if (profile.variant) {
        formHead.push(h('span', {
          className: 'chip' + (profile.variant === 'green' ? ' chip-inferred' : ''),
          title: profile.variant === 'green'
            ? 'Inferred: Riki INIT form 15 plus Asura\'s FAQ; not a transformation target'
            : 'Documented in the guide transformation table'
        }, profile.variant));
      }
    } else {
      formHead = [t(profile.formId === null
        ? 'not in the record'
        : 'form ' + hex2(profile.formId) + ' has no name')];
    }

    var targetBlock;
    if (options.monsterFormsError) {
      // The table did not load, so this is not evidence that no row exists.
      // The error paragraph below explains what stayed hidden.
      targetBlock = null;
    } else if (!profile.targets.length) {
      targetBlock = h('p', { className: 'hint' }, profile.known
        ? 'Starting form: the guide lists no transformation check that reaches it.'
        : 'No documented transformation row matches this form id.');
    } else {
      var first = profile.targets[0];
      targetBlock = h('div', { className: 'monster-target' },
        h('h5', null, 'Transformation check  ',
          h('span', { className: 'count' }, 'table ' + formatNumber(first.table))),
        monsterTargetLines(first, options.resolver),
        first.table === 2 && first.hp_below !== null
          ? h('span', { className: 'monster-line' },
              'Checked while max HP is below ' + formatNumber(first.hp_below) + '.')
          : null,
        profile.targets.length > 1
          ? h('p', { className: 'hint' },
              countLabel(profile.targets.length, 'documented row', 'documented rows') +
              ' reach this form; the first is shown.')
          : null
      );
    }

    return h('div', { className: 'detail-block monster-form' },
      h('h4', null, 'Monster form  ', h('span', { className: 'count' }, 'race ' + hex2(profile.race))),
      h('dl', { className: 'kv' },
        kv('Current form', h('span', { className: 'monster-value' }, formHead)),
        kv('Base HP', formatNumber(profile.baseHp)),
        kv('Prime HP', h('span', { className: 'monster-value' },
          t(formatNumber(profile.primeHp) + '  '),
          h('span', { className: 'hint' },
            '(' + formatNumber(profile.absorbedCount) + ' of 128 monster abilities x ' +
            formatNumber(PRIME_HP_PER_ABILITY) + ')'))),
        kv('Max in form', formatNumber(profile.maxHp)),
        kv('Absorbed', formatNumber(profile.absorbedCount) + ' of 128 monster abilities')
      ),
      targetBlock,
      options.monsterFormsError
        ? h('p', { className: 'hint' }, options.monsterFormsError +
            '. The form id and Prime HP still decode; names and requirements stay hidden until that table loads.')
        : null,
      h('p', { className: 'hint' },
        'The form byte is the first byte of the record\u2019s private scratch block. ' +
        'Base HP is the value stored in this record; Prime HP is four points per distinct ' +
        'absorbed monster ability (ids 128-255). Names and requirement rows are documented ' +
        'data from the Data Mechanics Guide transformation tables.')
    );
  }

  // Per-character drill-down. Pure: it takes the view model and returns a
  // descriptor tree, so the harness can assert on it without a DOM.
  function buildCharacterDetail(vm, resolver, chrNo, options) {
    var record = null;
    (vm.roster || []).forEach(function (candidate) {
      if (record === null && candidate.chrNo === chrNo) record = candidate;
    });
    if (!record) return null;

    var gifts = decodeGifts(record.nature);
    var race = raceLabel(record.race);
    // Only a Mec gets a body profile; for every other race this stays null and
    // the card is exactly what it was.
    var profile = buildMecProfile(record, resolver);
    var mystic = buildMysticAbsorbs(record, resolver);
    var monster = buildMonsterForm(record, resolver);
    var hasMysticGift = gifts.gifts.some(function (bit) { return bit.name === 'Mystic'; });

    // Position in the roster, 1-based, so a keyboard user scrolled down to this
    // card can still tell which row they are on while the table is off-screen.
    var rosterTotal = (vm.roster || []).length;
    var rosterRow = -1;
    (vm.roster || []).forEach(function (candidate, index) {
      if (rosterRow < 0 && candidate.chrNo === chrNo) rosterRow = index;
    });

    var artEntries = (record.equipAttack || []).map(function (id) {
      return { id: id, resolved: resolver.ability(id) };
    });
    var itemParts = profile ? profile.parts : [];
    var itemEntries = (record.equipItem || []).map(function (id, index) {
      var part = itemParts[index];
      return {
        id: id,
        resolved: resolver.item(id),
        boost: part && part.known ? part.boost : null
      };
    });
    var learned = (record.skills || []).map(function (entry) {
      return { id: entry.abilityId, resolved: resolver.ability(entry.abilityId) };
    });
    var groups = groupLearned(learned);

    var giftChips = gifts.gifts.map(function (bit) {
      return h('span', { className: 'chip' }, bit.name);
    });
    if (gifts.undecoded) {
      giftChips.push(h('span', { className: 'chip chip-unknown', title: 'Bits outside the documented legend' },
        'undecoded ' + hex2(gifts.undecoded)));
    }

    var identity = h('dl', { className: 'kv' },
      kv('Race', race.label
        ? [t(race.label + '  '), h('span', { className: 'mono' }, hex2(race.raw))]
        : [t('undecoded  '), h('span', { className: 'mono' }, hex2(race.raw))]),
      kv('Gifts', giftChips.length
        ? h('span', { className: 'chips' }, giftChips)
        : [t('none  '), h('span', { className: 'mono' }, '0x00')]),
      kv('Type byte (0x17)', formatNumber(record.getType)),
      kv('Record', 'index ' + formatNumber(record.index) + ', chr ' + hex2(record.chrNo))
    );

    var equipped = h('div', { className: 'detail-block' },
      h('h4', null, 'Equipped arts (eqpAtk)'),
      artEntries.length
        ? h('ul', { className: 'detail-list' }, artEntries.map(function (entry) {
            return abilityListItem(entry, resolver);
          }))
        : h('p', { className: 'empty' }, 'No equipped arts.'),
      h('h4', null, 'Equipped items (eqpItm)'),
      itemEntries.length
        ? h('ul', { className: 'detail-list' }, itemEntries.map(function (entry) {
            return h('li', { className: 'detail-item' },
              h('span', { className: 'ability-name' }, nameWithBadge(entry.resolved, entry.id)),
              h('span', { className: 'mono' }, hex2(entry.id)),
              entry.boost
                ? h('span', { className: 'detail-boosts mono' }, statBoostText(entry.boost))
                : null
            );
          }))
        : h('p', { className: 'empty' }, 'No equipped items.')
    );

    var learnedBlock = h('div', { className: 'detail-block' },
      h('h4', null, 'Learned arts by school'),
      groups.length
        ? groups.map(function (group) {
            var label = ABILITY_SECTION_LABELS[group.key] || group.key;
            return h('div', { className: 'learned-group' },
              h('h5', null, label + '  ', h('span', { className: 'count' }, group.entries.length)),
              h('ul', { className: 'detail-list' }, group.entries.map(function (entry) {
                return abilityListItem(entry, resolver);
              }))
            );
          })
        : h('p', { className: 'empty' }, 'No learned arts in this record.')
    );

    return h('section', { className: 'card card-wide character-detail', id: 'character-detail', 'data-index-label': 'Character detail' },
      h('h3', null, 'Character detail  ',
        nameWithBadge(resolver.character(record.chrNo), record.chrNo),
        h('span', { className: 'count' }, 'chr ' + hex2(record.chrNo)),
        rosterRow >= 0
          ? h('span', { className: 'count roster-position', 'data-roster-row': String(rosterRow + 1) },
              'roster row ' + formatNumber(rosterRow + 1) + ' of ' + formatNumber(rosterTotal))
          : null),
      identity,
      buildMecProfileBlock(profile, options),
      // A Human with the Mystic gift but no weapon arts and no stored absorb
      // gets an explanation, not an empty three-row panel. Asellus in her own
      // scenario is the measured case.
      !mystic && hasMysticGift
        ? h('p', { className: 'hint' },
            'Mystic gift, but no Mystic weapon arts and no stored absorbs. This record cannot absorb monsters.')
        : null,
      buildMysticAbsorbBlock(mystic, options),
      buildMonsterFormBlock(monster, {
        resolver: resolver,
        monsterFormsError: options && options.monsterFormsError
      }),
      h('div', { className: 'detail-columns' }, equipped, learnedBlock)
    );
  }

  function characterPairText(pair) {
    return (pair[0] === null ? '-' : pair[0]) + '/' + (pair[1] === null ? '-' : pair[1]);
  }

  function countLabel(count, singular, plural) {
    return count + ' ' + (count === 1 ? singular : plural);
  }

  // Compact projection of the roster record for the sticky rail. It is a
  // drill-over, not a second full card: the wide character detail keeps its
  // place in the page, and this surface carries only the fields that fit in the
  // 340px sidebar without adding sidebar height.
  function buildCharacterRail(vm, resolver, chrNo) {
    var record = rosterRecordFor(vm, chrNo);
    if (!record) return null;

    var gifts = decodeGifts(record.nature);
    var race = raceLabel(record.race);
    // A Mec's body TYPE is its identity: "Mec" alone does not say which frame.
    // The compact summary carries it on the Race line rather than as a new row,
    // so the sidebar does not grow.
    var profile = buildMecProfile(record, resolver);
    // A Monster's current form is its identity too: "Monster" alone does not
    // say Lummox or Skeleton. It rides on the Race line beside the Mec TYPE, so
    // the summary keeps the same two rows. Without the form table the id still
    // decodes, so show that rather than dropping the identity entirely.
    var monster = buildMonsterForm(record, resolver);
    var formText = monster && monster.formId !== null
      ? (monster.name
          ? monster.name + (monster.variant ? ' (' + monster.variant + ')' : '')
          : 'form ' + hex2(monster.formId))
      : null;
    var giftNames = gifts.gifts.map(function (bit) { return bit.name; });
    var giftText = giftNames.length ? giftNames.join(', ') : 'none';
    if (gifts.undecoded) giftText += ' + undecoded ' + hex2(gifts.undecoded);

    var total = (vm.roster || []).length;
    var row = -1;
    (vm.roster || []).forEach(function (candidate, index) {
      if (row < 0 && candidate.chrNo === chrNo) row = index;
    });

    var vitals = [
      ['HP', formatNumber(record.hpMax)],
      ['LP', characterPairText(record.lp)],
      ['WP', characterPairText(record.wp)],
      ['JP', characterPairText(record.jp)]
    ];
    var stats = STAT_FIELDS.map(function (field) {
      return [field.code, record.stats[field.key]];
    });

    return h('div', { className: 'rail-character', 'data-character': hex2(record.chrNo) },
      h('div', { className: 'rail-character-head' },
        h('span', { className: 'rail-character-name' },
          nameWithBadge(resolver.character(record.chrNo), record.chrNo)),
        h('span', { className: 'rail-character-meta' },
          'chr ' + hex2(record.chrNo) + ' / row ' + formatNumber(row + 1) + ' of ' + formatNumber(total))
      ),
      h('dl', { className: 'rail-facts' },
        h('div', null,
          h('dt', null, 'Race'),
          h('dd', null,
            race.label || 'undecoded',
            profile && profile.bodyName ? ' ' + profile.bodyName : null,
            formText ? ' ' + formText : null,
            h('span', { className: 'rail-raw mono' }, '  ' + hex2(race.raw)))
        ),
        h('div', null,
          h('dt', null, 'Gifts'),
          h('dd', null, giftText)
        )
      ),
      h('div', { className: 'rail-vitals' }, vitals.map(function (entry) {
        return h('div', { className: 'rail-vital' },
          h('span', { className: 'rail-vital-label' }, entry[0]),
          h('span', { className: 'rail-vital-value' }, entry[1])
        );
      })),
      h('div', { className: 'rail-stats' }, stats.map(function (entry) {
        return h('div', { className: 'rail-stat' },
          h('span', { className: 'rail-stat-label' }, entry[0]),
          h('span', { className: 'rail-stat-value' }, formatNumber(entry[1]))
        );
      })),
      h('p', { className: 'rail-counts' },
        countLabel(record.equipAttack.length, 'art', 'arts') + ' / ' +
        countLabel(record.equipItem.length, 'item', 'items') + ' / ' +
        countLabel((record.skills || []).length, 'learned art', 'learned arts'))
    );
  }

  function buildAbilities(vm, resolver) {
    var populated = [];
    vm.roster.forEach(function (record) {
      var arts = (record.equipAttack || []).map(function (id) {
        return { id: id, resolved: resolver.ability(id) };
      });
      var items = (record.equipItem || []).map(function (id) {
        return { id: id, resolved: resolver.item(id) };
      });
      var learned = (record.skills || []).map(function (entry) {
        return { id: entry.abilityId, resolved: resolver.ability(entry.abilityId) };
      });
      if (!arts.length && !items.length && !learned.length) return;
      populated.push({ record: record, arts: arts, items: items, learned: learned });
    });

    var body = populated.map(function (row) {
      var learnedGroups = groupLearned(row.learned);
      return h('tr', null,
        h('td', { className: 'mono', 'data-label': 'CHR' }, hex2(row.record.chrNo)),
        h('td', { 'data-label': 'Character' }, nameWithBadge(resolver.character(row.record.chrNo), row.record.chrNo)),
        h('td', { 'data-label': 'Equipped arts' }, joinResolved(row.arts, resolver, 'ability')),
        h('td', { 'data-label': 'Equipped items' }, joinResolved(row.items, resolver, 'item')),
        h('td', { 'data-label': 'Learned arts' }, learnedGroups.length
          ? learnedGroups.map(function (group) {
              var label = ABILITY_SECTION_LABELS[group.key] || group.key;
              return h('div', null,
                h('span', { className: 'group-label' }, label + ': '),
                group.entries.map(function (entry) {
                  return displayName(entry.resolved, entry.id);
                }).join(', '),
                // Keeps adjacent groups from running together in copied or
                // screen-reader text; block layout already separates them.
                ' ');
            })
          : '-')
      );
    });

    var totalLearned = populated.reduce(function (acc, row) {
      return acc + row.learned.length;
    }, 0);

    return h('section', { className: 'card card-wide', id: 'abilities', 'data-index-label': 'Abilities' },
      h('h3', null, 'Equipped and learned abilities'),
      h('p', { className: 'hint' },
        'Equipped arts (eqpAtk), equipped items (eqpItm) and learned arts (getskill) resolved to names. ' +
        'getskill is a 64-byte bit grid: bit b of grid byte i is ability id i * 8 + b, counting from record byte 0x38. ' +
        'Ability names come from the community data project, so they are documented rather than asset-extracted. ' +
        'Only characters with at least one entry are listed (' + populated.length + ' of ' +
        vm.roster.length + ', ' + totalLearned + ' learned arts in total).'),
      body.length
        ? h('div', { className: 'table-scroll' },
            h('table', { className: 'grid grid-abilities' },
              h('thead', null, h('tr', null,
                h('th', null, 'chr'),
                h('th', null, 'Character'),
                h('th', null, 'Equipped arts'),
                h('th', null, 'Equipped items'),
                h('th', null, 'Learned arts')
              )),
              h('tbody', null, body)
            )
          )
        : h('p', { className: 'empty' }, 'No character in this slot has equipped or learned abilities.')
    );
  }

  // Roster-wide view of the eight ability schools. It exists so a school that
  // no character has - in practice the 16 enemy abilities - stays visible; the
  // per-character list only renders groups that actually have entries.
  function rosterRecordFor(vm, chrNo) {
    var found = null;
    (vm.roster || []).forEach(function (record) {
      if (found === null && record.chrNo === chrNo) found = record;
    });
    return found;
  }

  // Every ability id a record references: learned arts plus equipped arts.
  function recordAbilityIds(record) {
    var ids = (record.skills || []).map(function (entry) { return entry.abilityId; });
    (record.equipAttack || []).forEach(function (id) { ids.push(id); });
    return ids;
  }

  function selectionLabel(vm, resolver, chrNo) {
    var record = rosterRecordFor(vm, chrNo);
    if (!record) return null;
    return {
      record: record,
      text: displayName(resolver.character(record.chrNo), record.chrNo) + ' (' + hex2(record.chrNo) + ')'
    };
  }

  function byteRangeLabel(section) {
    var start = parseInt(section.offset, 16);
    var end = start + (section.bytes || 1) - 1;
    return section.offset + '-' + '0x' + (end < 16 ? '0' : '') + end.toString(16).toUpperCase();
  }

  function buildAbilitySchools(vm, resolver, chrNo) {
    var sections = resolver && typeof resolver.sections === 'function' ? resolver.sections() : [];
    if (!sections.length) return null;

    var selection = selectionLabel(vm, resolver, chrNo);
    var selectedIds = selection ? recordAbilityIds(selection.record) : [];
    var heldByRecord = vm.roster.map(recordAbilityIds);

    var rows = sections.map(function (section) {
      var lo = section.ability_ids[0];
      var hi = section.ability_ids[1];
      var inRange = function (ids) {
        return ids.filter(function (id) { return id >= lo && id <= hi; }).length;
      };
      return {
        section: section,
        holders: heldByRecord.filter(function (ids) { return inRange(ids) > 0; }).length,
        selected: inRange(selectedIds)
      };
    });

    var enemyRow = null;
    rows.forEach(function (row) {
      if (row.section.key === 'enemy') enemyRow = row;
    });

    var body = rows.map(function (row) {
      var section = row.section;
      var inferred = typeof section.basis === 'string' && section.basis.indexOf('inferred') === 0;
      return h('tr', { className: row.holders === 0 ? 'school-unused' : null },
        h('td', { 'data-label': 'School' }, section.label,
          h('span', { className: 'badge badge-' + (inferred ? 'ambiguous' : 'documented') },
            inferred ? 'inferred' : 'documented')),
        h('td', { className: 'mono', 'data-label': 'Byte' }, byteRangeLabel(section)),
        h('td', { className: 'mono', 'data-label': 'Ability ids' }, section.ability_ids[0] + '-' + section.ability_ids[1]),
        h('td', { className: 'num', 'data-label': 'Held by' }, row.holders + ' of ' + vm.roster.length),
        h('td', { className: 'num' + (row.selected ? ' is-hit' : ' is-zero'), 'data-label': 'Selected' }, formatNumber(row.selected))
      );
    });

    var enemyParts = null;
    if (enemyRow) {
      var lo = enemyRow.section.ability_ids[0];
      var hi = enemyRow.section.ability_ids[1];
      var entries = [];
      for (var id = lo; id <= hi; id++) entries.push(id);
      enemyParts = [
        h('h4', null, 'Enemy abilities (' + enemyRow.section.offset + ')'),
        h('p', { className: 'hint' }, enemyRow.holders === 0
          ? 'No roster record in this save holds any of these 16, which is why the school never appears ' +
            'in a character\u2019s learned list. They are enemy AI and boss actions, not learnable arts.'
          : 'Held by ' + enemyRow.holders + ' of ' + vm.roster.length + ' roster records.'),
        h('ul', { className: 'chips chips-abilities' }, entries.map(function (abilityId) {
          return h('li', {
            className: 'chip chip-ability',
            title: '0x' + hex4(abilityId) + ' - ' + displayName(resolver.ability(abilityId), abilityId)
          },
            h('span', { className: 'mono' }, hex4(abilityId)), ' ',
            displayName(resolver.ability(abilityId), abilityId));
        }))
      ];
    }

    return h('section', { className: 'card card-wide', id: 'ability-schools', 'data-index-label': 'Ability schools' },
      h('h3', null, 'Ability schools'),
      h('p', { className: 'hint' },
        'Roster coverage per school, counting learned arts (getskill) and equipped arts (eqpAtk). ' +
        'A school nothing uses is still listed, so an empty block stays visible instead of ' +
        'silently disappearing from every character\u2019s learned list. ' +
        (selection
          ? 'The Selected column counts ' + selection.text + '.'
          : 'No roster record is selected, so the Selected column is empty.')),
      h('div', { className: 'table-scroll' },
        h('table', { className: 'grid grid-schools' },
          h('thead', null, h('tr', null,
            h('th', null, 'School'),
            h('th', null, 'Byte'),
            h('th', null, 'Ability ids'),
            h('th', null, 'Held by'),
            h('th', null, 'Selected')
          )),
          h('tbody', null, body))),
      enemyParts);
  }

  // Roster-wide element coverage, the companion to the school table: which of
  // the documented flags any equipped art actually carries, and which are
  // unused. An unused flag stays in the table rather than disappearing.
  function buildElementCoverage(vm, resolver, chrNo) {
    var legend = resolver && typeof resolver.elementLegend === 'function' ? resolver.elementLegend() : {};
    var order = resolver && typeof resolver.elementOrder === 'function' ? resolver.elementOrder() : [];
    if (!order.length) return null;

    var selection = selectionLabel(vm, resolver, chrNo);
    var stats = {};
    order.forEach(function (code) {
      stats[code] = { code: code, label: legend[code] || code, arts: 0, characters: 0, selected: 0 };
    });

    var equippedTotal = 0;
    vm.roster.forEach(function (record) {
      var seen = {};
      var isSelected = selection !== null && record.chrNo === selection.record.chrNo;
      (record.equipAttack || []).forEach(function (id) {
        equippedTotal++;
        (resolver.ability(id).elements || []).forEach(function (code) {
          var entry = stats[code];
          if (!entry) return; // flag outside the documented legend
          entry.arts++;
          if (isSelected) entry.selected++;
          if (!seen[code]) {
            seen[code] = true;
            entry.characters++;
          }
        });
      });
    });
    var selectedEquipped = selection ? (selection.record.equipAttack || []).length : 0;

    var body = order.map(function (code) {
      var entry = stats[code];
      return h('tr', { className: entry.arts === 0 ? 'element-unused' : null },
        h('td', { 'data-label': 'Element' }, entry.label),
        h('td', { className: 'mono', 'data-label': 'Code' }, code),
        h('td', { className: 'num', 'data-label': 'Equipped arts' }, formatNumber(entry.arts)),
        h('td', { className: 'num', 'data-label': 'Characters' }, formatNumber(entry.characters)),
        h('td', { className: 'num' + (entry.selected ? ' is-hit' : ' is-zero'), 'data-label': 'Selected' }, formatNumber(entry.selected))
      );
    });

    var unused = order.filter(function (code) { return stats[code].arts === 0; });
    var unusedText = unused.length
      ? 'Not carried by any equipped art: ' + unused.join(', ') + '.'
      : 'Every documented flag is carried by at least one equipped art.';

    return h('section', { className: 'card card-wide', id: 'element-coverage', 'data-index-label': 'Element coverage' },
      h('h3', null, 'Element coverage'),
      h('p', { className: 'hint' },
        'Flags carried by the ' + formatNumber(equippedTotal) + ' equipped arts (eqpAtk) across the ' +
        'whole roster, counting each flag once per art. A flag nothing carries is still listed, ' +
        'so an unused element stays visible. ' +
        (selection
          ? 'The Selected column counts the ' + formatNumber(selectedEquipped) + ' arts equipped by ' + selection.text + '.'
          : 'No roster record is selected, so the Selected column is empty.')),
      h('div', { className: 'table-scroll' },
        h('table', { className: 'grid grid-elements' },
          h('thead', null, h('tr', null,
            h('th', null, 'Element'),
            h('th', null, 'Code'),
            h('th', null, 'Equipped arts'),
            h('th', null, 'Characters'),
            h('th', null, 'Selected')
          )),
          h('tbody', null, body))),
      h('p', { className: unused.length ? 'hint unused-note' : 'hint' }, unusedText));
  }

  // Arrow/Home/End targets for the roster. Returns the row index to move to,
  // or null when the key is not a roster navigation key. Clamped rather than
  // wrapped: holding Home must not send you somewhere else.
  function rosterTargetFor(key, index, length) {
    if (!length || index < 0) return null;
    if (key === 'ArrowDown') return Math.min(index + 1, length - 1);
    if (key === 'ArrowUp') return Math.max(index - 1, 0);
    if (key === 'Home') return 0;
    if (key === 'End') return length - 1;
    return null;
  }

  // System file: one block per file, shared by every slot. It is deliberately a
  // separate card from Party, because showing it per slot implies it varies.
  function buildSystemFile(vm) {
    var system = vm.system;
    if (!system) {
      return h('section', { className: 'card card-wide', id: 'system-file', 'data-index-label': 'System file' },
        h('h3', null, 'System file'),
        h('p', { className: 'empty' }, 'This file carries no systemSaveData block.'));
    }

    var started = startedScenarioNames(system);
    var finished = [];
    (system.end || []).forEach(function (value, index) {
      if (num(value)) finished.push(scenarioName(index));
    });
    var trueEndings = [];
    (system.end2 || []).forEach(function (value, index) {
      if (num(value)) trueEndings.push(scenarioName(index));
    });
    var counters = system.counters || {};
    var counterText = [
      counters.kills !== null ? formatNumber(counters.kills) + ' kills' : null,
      counters.waza !== null ? formatNumber(counters.waza) + ' waza uses' : null,
      counters.jutsu !== null ? formatNumber(counters.jutsu) + ' jutsu uses' : null,
      counters.maxCombo !== null ? 'max combo ' + formatNumber(counters.maxCombo) : null,
      counters.maxTurns !== null ? 'longest battle ' + formatNumber(counters.maxTurns) + ' turns' : null,
      counters.damage !== null ? formatNumber(counters.damage) + ' damage dealt' : null
    ].filter(Boolean);

    return h('section', { className: 'card card-wide', id: 'system-file', 'data-index-label': 'System file' },
      h('h3', null, 'System file'),
      h('p', { className: 'hint' },
        'One system block per save file, shared by every slot below it. Values here are ' +
        'not per-slot state, so they do not change when you select a different slot.'),
      h('dl', { className: 'kv' },
        kv('Scenario-clear rank record (sfSys.parLev)', systemClearRankLabel(system)),
        kv('Blood type', systemValueLabel(system.blood, 'questionnaire answer; no verified effect')),
        kv('Zodiac (seiza)', systemValueLabel(system.zodiac, 'questionnaire answer; no verified effect')),
        kv('Learning', [t(formatByteList(system.learning) + '  '),
          h('span', { className: 'rank-note' }, 'purpose unmapped')]),
        kv('Scenarios started', started.length ? started.join(', ') : 'none'),
        kv('Scenarios finished', finished.length ? finished.join(', ') : 'none'),
        kv('True-ending records', trueEndings.length ? trueEndings.join(', ') : 'none'),
        kv('Profile name bytes', h('code', { className: 'mono' }, formatByteList(system.nameBytes))),
        kv('Playthrough counters', counterText.length ? counterText.join(', ') : 'none recorded'),
        kv('Integrity fields', h('code', { className: 'mono' },
          'chk ' + formatByteList(system.integrity.chk) +
          ' / chk2 ' + formatByteList(system.integrity.chk2) +
          ' / chk3 ' + formatByteList(system.integrity.chk3) +
          ' / chk4 ' + formatByteList(system.integrity.chk4) +
          ' / sum ' + formatByteList(system.integrity.sum)))
      ),
      h('p', { className: 'hint' },
        'Blood type and zodiac are the System Data questionnaire answers. No source establishes ' +
        'a stat, luck, drop, encounter or dialogue effect for either; they identify the profile. ' +
        'The integrity fields have no known algorithm and are shown raw, never validated. ' +
        'The learning array is present but its eight values are unmapped.')
    );
  }

  // Purchase totals over the fixed shop tables. Entries are counted, not
  // distinct ids, because the achievement is about every item each shop sells;
  // the distinct count is reported separately because items repeat across shops.
  function summarizeShopRecords(records) {
    var totalEntries = 0;
    var purchasedEntries = 0;
    var complete = 0;
    var touched = 0;
    var allIds = {};
    var boughtIds = {};

    (records || []).forEach(function (shop) {
      var shopTotal = shop.items.length;
      var shopBought = 0;
      shop.items.forEach(function (item) {
        totalEntries++;
        if (item.id !== null) allIds[item.id] = true;
        var count = num(item.count) || 0;
        if (count > 0) {
          purchasedEntries++;
          shopBought++;
          if (item.id !== null) boughtIds[item.id] = true;
        }
      });
      if (shopBought > 0) touched++;
      if (shopTotal > 0 && shopBought === shopTotal) complete++;
    });

    return {
      tables: (records || []).length,
      totalEntries: totalEntries,
      purchasedEntries: purchasedEntries,
      distinctItems: Object.keys(allIds).length,
      distinctBought: Object.keys(boughtIds).length,
      complete: complete,
      touched: touched
    };
  }

  function shopPercent(bought, total) {
    if (!total) return '0.0%';
    return (bought / total * 100).toFixed(1) + '%';
  }

  // Shop purchase ledger. Global like the System file, so it sits beside it
  // rather than inside a slot. Table numbers are the save's Type ids; no source
  // maps them to shop or town names, so none are invented.
  function buildShopRecord(vm, resolver, options) {
    var records = vm.system && vm.system.shopRecords;
    if (!records || !records.length) return null;
    // Open stops are owned by the controller, not by the descriptor tree: the
    // card is rebuilt on every slot switch, and the user's place in the route
    // should survive that.
    var openLocations = (options && options.openLocations) || {};
    var onToggle = options && typeof options.onShopToggle === 'function'
      ? options.onShopToggle
      : null;

    var summary = summarizeShopRecords(records);
    var duplicates = summary.totalEntries - summary.distinctItems;

    var blocks = records.map(function (shop) {
      var bought = shop.items.filter(function (item) { return (num(item.count) || 0) > 0; }).length;
      var isComplete = shop.items.length > 0 && bought === shop.items.length;
      var isTouched = bought > 0;
      var state = isComplete ? 'complete' : (isTouched ? 'partial' : 'empty');
      var info = resolver.shop(shop.type);
      var label = info.label || ('Shop table ' + (shop.type === null ? '?' : formatNumber(shop.type)));
      var summaryTitle = 'Type ' + (shop.type === null ? '?' : formatNumber(shop.type)) +
        (info.basis ? '. ' + info.basis : '');

      var rows = shop.items.map(function (item) {
        var count = num(item.count) || 0;
        var name = item.id === null
          ? 'Unknown item'
          : displayName(resolver.item(item.id), item.id);
        return h('tr', { className: count > 0 ? 'shop-bought' : 'shop-unbought' },
          h('td', null, name),
          h('td', { className: 'mono' }, item.id === null ? '??' : hex2(item.id)),
          h('td', { className: 'num' }, count > 0 ? formatNumber(count) : '-')
        );
      });

      return h('details', { className: 'shop-set is-' + state, open: isTouched },
        h('summary', { title: summaryTitle },
          label,
          isComplete ? h('span', { className: 'badge badge-asset' }, 'complete') : null,
          isTouched && !isComplete ? h('span', { className: 'badge badge-documented' }, 'in progress') : null,
          info.confidence === 'medium'
            ? h('span', { className: 'badge badge-ambiguous' }, 'label inferred')
            : null,
          h('span', { className: 'count' },
            ' ' + formatNumber(bought) + ' of ' + formatNumber(shop.items.length) + ' bought')
        ),
        h('div', { className: 'table-scroll' },
          h('table', { className: 'grid grid-shop' },
            h('thead', null, h('tr', null,
              h('th', null, 'Item'),
              h('th', null, 'ID'),
              h('th', null, 'Bought'))),
            h('tbody', null, rows))));
    });

    // Strict checklist of every stock entry whose count is still zero. Grouped
    // as a route: one block per location, then one row per stock table inside
    // it, because a single location can sell several separate lists. An item
    // bought at one shop stays listed at another: purchases are per table.
    var remainingEntries = 0;
    var remainingTables = 0;
    var locations = [];
    var locationIndex = {};
    records.forEach(function (shop) {
      var missing = shop.items.filter(function (item) {
        return (num(item.count) || 0) <= 0;
      });
      if (!missing.length) return;
      remainingTables++;
      remainingEntries += missing.length;
      var missingInfo = resolver.shop(shop.type);
      var location = missingInfo.location || 'Unlabelled tables';
      var stockLabel = missingInfo.label ||
        ('Shop table ' + (shop.type === null ? '?' : formatNumber(shop.type)));
      // Labels are 'location - stock', so a labelled table drops the location
      // prefix inside its location block; an unlabelled one keeps the fallback.
      if (missingInfo.location && missingInfo.label &&
          missingInfo.label.indexOf(location + ' - ') === 0) {
        stockLabel = missingInfo.label.slice(location.length + 3);
      }
      var group = locationIndex[location];
      if (!group) {
        group = locationIndex[location] = { location: location, shops: [], entries: 0 };
        locations.push(group);
      }
      group.shops.push({ label: stockLabel, items: missing });
      group.entries += missing.length;
    });
    var remainingDistinct = summary.distinctItems - summary.distinctBought;

    // Labels and grouping come from different fields of the same table, so a
    // missing or stale copy degrades them separately. Say which happened rather
    // than letting every table fall into "Unlabelled tables" without comment.
    var labelCounts = { total: records.length, labelled: 0, located: 0 };
    records.forEach(function (shop) {
      var info = resolver.shop(shop.type);
      if (info && info.label) labelCounts.labelled++;
      if (info && info.location) labelCounts.located++;
    });
    var labelState = labelCounts.located === labelCounts.total ? 'ok'
      : (labelCounts.labelled === 0 ? 'missing'
        : (labelCounts.located === 0 ? 'stale' : 'partial'));
    var labelWarning = null;
    if (labelState === 'missing') {
      labelWarning = (options && options.shopTableError
        ? options.shopTableError
        : 'docs/shop_names.json did not load') +
        '. Shop tables are shown by number and grouped as Unlabelled tables. ' +
        'Reload the page; if it persists, serve the viewer over HTTP.';
    } else if (labelState === 'stale') {
      labelWarning = 'The loaded docs/shop_names.json predates the location field '
        + '(schema 1), so the labels resolve but their grouping cannot. Reload the page '
        + 'to pick up schema 2 of the table.';
    } else if (labelState === 'partial') {
      labelWarning = 'Shop tables without a location in docs/shop_names.json: ' +
        formatNumber(labelCounts.total - labelCounts.located) + ' of ' +
        formatNumber(labelCounts.total) + '. Those are grouped as Unlabelled tables. ' +
        'The table is inconsistent; reload or regenerate it.';
    }

    var remainingPanel = h('div', { className: 'shop-remaining', id: 'shop-remaining' },
      h('h4', null, 'Still to buy'),
      h('p', { className: 'hint' }, remainingEntries
        ? 'Still unbought: ' + formatNumber(remainingEntries) + ' of ' +
          formatNumber(summary.totalEntries) + ' stock entries across ' +
          formatNumber(remainingTables) + ' of ' + formatNumber(summary.tables) +
          ' tables in ' +
          formatNumber(locations.length) + ' locations; ' +
          formatNumber(remainingDistinct) + ' distinct items have never been ' +
          'bought anywhere. Expand a location to see what is still missing there. ' +
          'This is the strict checklist: an item bought at one shop stays ' +
          'listed at another, because purchases are recorded per table.'
        : 'Nothing left to buy: all ' + formatNumber(summary.totalEntries) +
          ' stock entries have been purchased.'),
      locations.map(function (group) {
        // Collapsed by default: the route is scanned as stops, and only the
        // stop being shopped needs its item rows open.
        return h('details', {
          className: 'shop-remaining-group',
          open: Boolean(openLocations[group.location]),
          onToggle: onToggle
            ? function (isOpen) { onToggle(group.location, isOpen); }
            : null
        },
          h('summary', null,
            // summary takes phrasing content, so the flex row is a span.
            h('span', { className: 'shop-remaining-head' },
              h('span', { className: 'shop-remaining-location' }, group.location),
              // A location with a single shop needs the total once; repeating it
              // on the row would just say the same number twice.
              h('span', { className: 'count' }, ' ' + formatNumber(group.entries) + ' left' +
                (group.shops.length > 1
                  ? ' in ' + formatNumber(group.shops.length) + ' shops'
                  : '')))),
          group.shops.map(function (row) {
            return h('div', { className: 'shop-remaining-row' },
              h('span', { className: 'shop-remaining-label' }, row.label),
              group.shops.length > 1
                ? h('span', { className: 'count' }, ' ' + formatNumber(row.items.length) + ' left')
                : null,
              h('p', { className: 'shop-remaining-items' }, row.items.map(function (item) {
                return item.id === null
                  ? 'Unknown item'
                  : displayName(resolver.item(item.id), item.id);
              }).join(', '))
            );
          })
        );
      })
    );

    return h('section', { className: 'card card-wide', id: 'shop-record', 'data-index-label': 'Shop record' },
      h('h3', null, 'Shop purchase record', h('span', { className: 'count' },
        ' ' + formatNumber(summary.purchasedEntries) + ' of ' +
        formatNumber(summary.totalEntries) + ' stock entries bought')),
      labelWarning
        ? h('p', { className: 'shop-label-warning', role: 'status' }, labelWarning)
        : null,
      h('p', { className: 'hint' },
        'Global, like the System file: one ledger per save file, shared by every slot. ' +
        'The seventeen stock tables are fixed game data - identical in both project saves - ' +
        'so only the purchase counts move. This is the data behind the Shopaholic achievement ' +
        '("purchased all types of items sold at shops"). Labels come from docs/shop_names.json, ' +
        'matched by where each stock list is sold; the game has no shop-name table, so an ' +
        'unmatched Type stays Shop table N. Hover a label for its evidence.'),
      h('dl', { className: 'kv' },
        kv('Stock entries bought', formatNumber(summary.purchasedEntries) + ' of ' +
          formatNumber(summary.totalEntries) + '  (' +
          shopPercent(summary.purchasedEntries, summary.totalEntries) + ')'),
        kv('Distinct items bought', formatNumber(summary.distinctBought) + ' of ' +
          formatNumber(summary.distinctItems) + (duplicates
            ? '  (' + formatNumber(duplicates) + ' items are stocked by more than one table)'
            : '')),
        kv('Shop tables complete', formatNumber(summary.complete) + ' of ' +
          formatNumber(summary.tables)),
        kv('Shop tables with a purchase', formatNumber(summary.touched) + ' of ' +
          formatNumber(summary.tables))
      ),
      h('div', null, blocks),
      remainingPanel
    );
  }

  // Named scenario flags. pty.snroFlg is 512 bytes. The card keeps the summary
  // that used to be its own "Flags and counters" card and exposes the same array
  // three ways: set bytes, unset bytes, and every byte. The separate 1024-byte
  // scenarioChartStateArray is preserved as a fourth view because the old card
  // counted it and the merge must not drop it.
  function buildScenarioFlags(vm, resolver, translations) {
    var rows = vm.scenarioFlags || [];
    var counters = vm.counters || {};
    var values = Array.isArray(vm.scenarioFlagValues) ? vm.scenarioFlagValues : [];
    var chartValues = Array.isArray(vm.scenarioChartValues) ? vm.scenarioChartValues : [];
    var total = num(counters.scenarioFlagBytes) || values.length || 0;
    if (!total && !rows.length) return null;
    var chartTotal = num(counters.scenarioChartTotal) || chartValues.length || 0;
    var chartSet = num(counters.scenarioChartSet);
    if (chartSet === null) {
      chartSet = chartValues.reduce(function (acc, value) {
        return acc + (num(value) ? 1 : 0);
      }, 0);
    }
    var glosses = (translations && translations.meanings) || {};
    var glossary = (translations && Array.isArray(translations.glossary))
      ? translations.glossary
      : [];
    var hasGlosses = Object.keys(glosses).length > 0;
    var blockNames = (translations && translations.blocks) || {};

    // English first, with the Japanese source kept underneath: the gloss is
    // unofficial and the original wording is the evidence, so neither replaces
    // the other. A meaning with no gloss falls back to Japanese alone.
    var meaningItem = function (item) {
      var english = glosses[item.meaning];
      if (!english) {
        return h('div', { className: 'flag-meaning-pair' },
          h('span', { className: 'flag-meaning' }, item.meaning));
      }
      return h('div', { className: 'flag-meaning-pair' },
        h('span', { className: 'flag-meaning' }, english),
        h('span', { className: 'flag-meaning-ja' }, item.meaning));
    };

    // Block labels are source identifiers, so the English display name sits
    // above the verbatim label; a missing name leaves the label alone.
    var blockCell = function (label) {
      if (!label) return h('span', { className: 'flag-unknown' }, 'unnamed');
      var english = blockNames[label];
      if (!english) return label;
      return h('div', { className: 'flag-block-pair' },
        h('span', { className: 'flag-block-en' }, english),
        h('span', { className: 'flag-block-ja' }, label));
    };

    // One decoded row per nonzero byte, reused by the Current and All views.
    var byIndex = {};
    rows.forEach(function (row) {
      byIndex[num(row.index)] = row;
    });
    var decode = function (index, value) {
      var row = byIndex[index];
      if (row && num(row.value) === value) return row;
      var block = resolver.flag(index);
      return {
        index: index,
        value: value,
        block: block,
        matched: matchFlagEntries(value, block)
      };
    };

    var flagRow = function (entry, dim) {
      var block = entry.block || resolver.flag(entry.index);
      var matched = entry.matched || matchFlagEntries(entry.value, block);
      var isSet = entry.value !== 0;
      var meaning;
      if (!isSet) {
        meaning = h('span', { className: 'flag-unknown' }, 'unset');
      } else if (block.status === 'unmapped') {
        meaning = h('span', { className: 'flag-unknown' }, 'not in the flag table');
      } else if (!matched.length) {
        meaning = h('span', { className: 'flag-unknown' }, 'no documented meaning for this value');
      } else {
        meaning = matched.map(function (item) { return meaningItem(item); });
      }
      var blockText = block.label
        ? blockCell(block.label)
        : (isSet
            ? h('span', { className: 'flag-unknown' }, 'unnamed')
            : h('span', { className: 'flag-unknown' }, '-'));
      return h('tr', { className: dim ? 'flag-row-unset' : null },
        h('td', { className: 'mono' },
          h('span', { className: 'flag-cell-label' }, 'Byte'), hex3(entry.index)),
        h('td', { className: 'mono' + (dim ? ' is-unset' : '') },
          h('span', { className: 'flag-cell-label' }, 'Value'), '0x' + hexByte(entry.value)),
        h('td', null,
          h('span', { className: 'flag-cell-label' }, 'Block'), blockText),
        h('td', null,
          h('span', { className: 'flag-cell-label' }, 'Meaning'), meaning)
      );
    };

    var flagTable = function (entries, dim) {
      if (!entries.length) {
        return h('p', { className: 'hint flag-empty' }, 'No bytes in this view.');
      }
      return h('div', { className: 'table-scroll flag-scroll' },
        h('table', { className: 'grid grid-flags flag-byte-grid' },
          h('thead', null, h('tr', null,
            h('th', null, 'Byte'),
            h('th', null, 'Value'),
            h('th', null, 'Block'),
            h('th', null, 'Meaning')
          )),
          h('tbody', null, entries.map(function (entry) {
            return flagRow(entry, dim && !entry.value);
          }))));
    };

    var currentEntries = rows.map(function (row) {
      return decode(num(row.index), num(row.value));
    });
    var unsetEntries = [];
    var allEntries = [];
    for (var i = 0; i < total; i++) {
      var value = num(values[i]);
      if (value === null) value = 0;
      var entry = value ? currentEntries.filter(function (row) { return row.index === i; })[0] : null;
      if (!entry) entry = decode(i, value);
      allEntries.push(entry);
      if (!value) unsetEntries.push(entry);
    }

    var chartEntries = [];
    for (var c = 0; c < chartTotal; c++) {
      var chartValue = num(chartValues[c]);
      if (chartValue) chartEntries.push({ index: c, value: chartValue });
    }
    var chartTable = h('div', { className: 'table-scroll flag-scroll' },
      h('table', { className: 'grid grid-flags' },
        h('thead', null, h('tr', null,
          h('th', null, 'Offset'),
          h('th', null, 'Value')
        )),
        h('tbody', null, chartEntries.length
          ? chartEntries.map(function (entry) {
              return h('tr', null,
                h('td', { className: 'mono' }, hex3(entry.index)),
                h('td', { className: 'mono' }, '0x' + hexByte(entry.value)));
            })
          : h('tr', null, h('td', { className: 'flag-unknown', colSpan: '2' }, 'no nonzero bytes')))));

    var viewRow = function (id, title, meta, body, open) {
      return h('details', { className: 'flag-view', id: id, open: open ? true : null },
        h('summary', null,
          h('span', { className: 'flag-view-title' }, title),
          h('span', { className: 'count' }, ' ' + meta)),
        body);
    };

    var summary = h('dl', { className: 'kv flag-summary' },
      kv('Scenario flags set', formatNumber(currentEntries.length) + ' of ' + formatNumber(total) + ' bytes'),
      kv('Roster records', formatNumber(counters.rosterCount)),
      chartTotal
        ? kv('Chart state bytes set', formatNumber(chartSet) + ' of ' + formatNumber(chartTotal))
        : null
    );

    return h('section', { className: 'card card-wide flag-card', id: 'scenario-flags', 'data-index-label': 'Scenario flags' },
      h('h3', null, 'Scenario flags', h('span', { className: 'count' },
        ' ' + formatNumber(currentEntries.length) + ' of ' + formatNumber(total) + ' bytes set')),
      summary,
      h('p', { className: 'hint' },
        'pty.snroFlg is a 512-byte scenario-flag array. Current flags lists the bytes with a ' +
        'nonzero value; Unset flags lists the rest; All flags shows every byte with unset rows ' +
        'dimmed. A byte is read as an exact state value first, then as individual bits; a byte ' +
        'the community note does not name stays raw. ' +
        (chartTotal
          ? 'The separate ' + formatNumber(chartTotal) + '-byte scenarioChartStateArray is listed ' +
            'raw because its meanings are not mapped yet. '
          : '') +
        (hasGlosses
          ? 'Each meaning shows an unofficial English gloss above the source Japanese, ' +
            'which is kept verbatim; the gloss is not official localization text. ' +
            (glossary.length
              ? 'The shared glossary below spells out recurring game terms.'
              : 'The English glossary did not load, so the source text is shown without it.') +
            (Object.keys(blockNames).length
              ? ' Block labels pair an English display name with the source label.'
              : '')
          : 'The English translation table did not load, so only the source text is shown.')),
      viewRow('scenario-flags-current', 'Current flags',
        formatNumber(currentEntries.length) + ' set', flagTable(currentEntries, false), true),
      viewRow('scenario-flags-unset', 'Unset flags',
        formatNumber(unsetEntries.length) + ' bytes', flagTable(unsetEntries, false), false),
      viewRow('scenario-flags-all', 'All flags',
        formatNumber(allEntries.length) + ' bytes', flagTable(allEntries, true), false),
      chartTotal
        ? viewRow('scenario-flags-chart', 'Chart state',
            formatNumber(chartSet) + ' of ' + formatNumber(chartTotal),
            chartValues.length
              ? chartTable
              : h('p', { className: 'hint flag-empty' },
                  'The chart state values did not load, so only the count is available.'),
            false)
        : null,
      glossary.length
        ? h('details', { className: 'flag-glossary' },
            h('summary', null, 'Glossary', h('span', { className: 'count' },
              ' ' + formatNumber(glossary.length) + ' game terms')),
            h('dl', { className: 'kv flag-glossary-list' }, glossary.map(function (term) {
              return kv(term.ja + '  ' + term.en, term.note || '');
            })))
        : null
    );
  }


  /* ------------------------------------------------------------------ *
   * INIT sets
   *
   * Four complete character baselines. The save does not record which one it
   * used, but untouched records still carry its values exactly, so comparing
   * the live roster with each set infers it. The thresholds are derived, not
   * observed, and are labelled that way.
   * ------------------------------------------------------------------ */

  // The save names the seven stats str/dex/hnd/mnd/mgc/con/chm while INITDATA
  // names them STR/QUI/INT/WIL/PSY/VIT/CHA. The mapping is the one proven by the
  // save/INIT1 comparison in the previous session, not an alphabetical guess.
  function initRecordFields(record) {
    return [record.hpMax, record.lp[1], record.wp[1], record.jp[1],
      record.stats.str, record.stats.dex, record.stats.hnd, record.stats.mnd,
      record.stats.mgc, record.stats.con, record.stats.chm,
      record.race, record.nature, record.getType];
  }

  function initSetFields(entry) {
    return [entry.hp, entry.lp, entry.wp, entry.jp,
      entry.stats.str, entry.stats.qui, entry.stats.int, entry.stats.wil,
      entry.stats.psy, entry.stats.vit, entry.stats.cha,
      entry.race, entry.gifts, entry.type];
  }

  function scoreInitSets(vm, initSets) {
    var sets = initSets && initSets.sets ? initSets.sets : {};
    var results = [];
    Object.keys(sets).forEach(function (key) {
      var table = sets[key] || {};
      var exactChars = 0;
      var comparedChars = 0;
      var exactFields = 0;
      var totalFields = 0;
      (vm.roster || []).forEach(function (record) {
        var entry = table[hex2(record.chrNo)];
        if (!entry) return;
        comparedChars++;
        var actual = initRecordFields(record);
        var expected = initSetFields(entry);
        var hits = 0;
        for (var i = 0; i < actual.length; i++) {
          if (actual[i] === expected[i]) hits++;
        }
        exactFields += hits;
        totalFields += actual.length;
        if (hits === actual.length) exactChars++;
      });
      results.push({
        set: key,
        exactChars: exactChars,
        comparedChars: comparedChars,
        exactFields: exactFields,
        totalFields: totalFields,
        ratio: totalFields ? exactFields / totalFields : 0
      });
    });
    results.sort(function (a, b) {
      if (b.exactChars !== a.exactChars) return b.exactChars - a.exactChars;
      return b.exactFields - a.exactFields;
    });
    return results;
  }

  function initConfidence(results) {
    if (!results.length) return 'none';
    var best = results[0];
    var share = best.comparedChars ? best.exactChars / best.comparedChars : 0;
    if (results.length < 2) return share >= 0.9 ? 'high' : (share >= 0.6 ? 'medium' : 'low');
    var margin = best.exactChars - results[1].exactChars;
    if (share >= 0.9 && margin >= Math.max(3, best.comparedChars * 0.2)) return 'high';
    if (share >= 0.6 && margin >= 2) return 'medium';
    return 'low';
  }

  function initPercent(value) {
    return (value * 100).toFixed(1) + '%';
  }

  function buildInitSets(vm, resolver, initSets) {
    if (!initSets || !initSets.sets) return null;
    var results = scoreInitSets(vm, initSets);
    if (!results.length) return null;

    var best = results[0];
    var confidence = initConfidence(results);
    var completed = hasCompletedScenario(vm.system);
    var prediction = predictInit(vm.system ? vm.system.parLev : null, completed);
    var gaps = (initSets.meta && initSets.meta.gaps) || {};
    var gapKeys = Object.keys(gaps);

    var scoreText = 'Baseline match: INIT ' + best.set + ' - ' + formatNumber(best.exactChars) +
      ' of ' + formatNumber(best.comparedChars) + ' records fully exact (' +
      initPercent(best.ratio) + ' of ' + formatNumber(best.totalFields) + ' fields). ' +
      'Confidence: ' + confidence + '.';

    var predictionText;
    if (!prediction) {
      predictionText = 'Next scenario: the system record is unavailable, so no set can be predicted.';
    } else if (prediction.set === '1') {
      predictionText = 'Next scenario: no scenario has been completed in this System file, ' +
        'so INIT 1 is expected. Derived from the guide rule that INIT 2-4 require a saved clear.';
    } else {
      predictionText = 'Next scenario: the last completed scenario ended at ' + prediction.range +
        ', which the guide places in INIT ' + prediction.set + '. parLev is the packed Battle ' +
        'Rank Points byte (16 per rank), so this is documented rather than observed; no ' +
        'completed-scenario save has been checked yet.';
    }

    var sets = initSets.sets;
    var blocks = Object.keys(sets).map(function (key) {
      var table = sets[key];
      var isBest = key === best.set;
      var rows = [];
      (vm.roster || []).forEach(function (record) {
        var entry = table[hex2(record.chrNo)];
        if (!entry) return;
        var gearNames = (entry.arts || []).map(function (id) {
          return displayName(resolver.ability(id), id);
        }).concat((entry.items || []).map(function (id) {
          return displayName(resolver.item(id), id);
        }));
        var actual = initRecordFields(record);
        var expected = initSetFields(entry);
        var diff = actual.some(function (value, index) { return value !== expected[index]; });
        rows.push(h('tr', { className: diff ? 'init-differs' : 'init-exact' },
          h('td', { className: 'mono', 'data-label': 'CHR' }, hex2(record.chrNo)),
          h('td', { 'data-label': 'Character' }, nameWithBadge(resolver.character(record.chrNo), record.chrNo)),
          h('td', { className: 'num', 'data-label': 'HP' }, formatNumber(entry.hp)),
          h('td', { className: 'num', 'data-label': 'LP' }, formatNumber(entry.lp)),
          h('td', { className: 'num', 'data-label': 'WP' }, formatNumber(entry.wp)),
          h('td', { className: 'num', 'data-label': 'JP' }, formatNumber(entry.jp)),
          h('td', { className: 'num', 'data-label': 'STR' }, formatNumber(entry.stats.str)),
          h('td', { className: 'num', 'data-label': 'QUI' }, formatNumber(entry.stats.qui)),
          h('td', { className: 'num', 'data-label': 'INT' }, formatNumber(entry.stats.int)),
          h('td', { className: 'num', 'data-label': 'WIL' }, formatNumber(entry.stats.wil)),
          h('td', { className: 'num', 'data-label': 'PSY' }, formatNumber(entry.stats.psy)),
          h('td', { className: 'num', 'data-label': 'VIT' }, formatNumber(entry.stats.vit)),
          h('td', { className: 'num', 'data-label': 'CHA' }, formatNumber(entry.stats.cha)),
          h('td', { className: 'num', title: gearNames.join(', ') || 'no equipment', 'data-label': 'Gear' },
            formatNumber((entry.arts || []).length + (entry.items || []).length)),
          h('td', { className: 'num', 'data-label': 'Learned' }, formatNumber(entry.learned))
        ));
      });

      return h('details', { className: 'init-set' + (isBest ? ' is-best' : ''), open: isBest },
        h('summary', null,
          'INIT ' + key,
          isBest ? h('span', { className: 'badge badge-asset' }, 'best match') : null,
          h('span', { className: 'count' }, ' ' + formatNumber(rows.length) + ' records')),
        h('div', { className: 'table-scroll' },
          h('table', { className: 'grid grid-init' },
            h('thead', null, h('tr', null,
              h('th', null, 'chr'),
              h('th', null, 'Character'),
              h('th', null, 'HP'),
              h('th', null, 'LP'),
              h('th', null, 'WP'),
              h('th', null, 'JP'),
              h('th', null, 'STR'),
              h('th', null, 'QUI'),
              h('th', null, 'INT'),
              h('th', null, 'WIL'),
              h('th', null, 'PSY'),
              h('th', null, 'VIT'),
              h('th', null, 'CHA'),
              h('th', null, 'Gear'),
              h('th', null, 'Learned')
            )),
            h('tbody', null, rows)))
      );
    });

    return h('section', { className: 'card card-wide', id: 'init-sets', 'data-index-label': 'INIT sets' },
      h('h3', null, 'INIT sets'),
      h('p', { className: 'hint' },
        'Every scenario starts by copying one of four complete character baselines over the ' +
        'roster. The set is chosen from the final Battle Rank of the last scenario completed ' +
        'into System Data. Rows are marked exact when all 14 compared fields match the live ' +
        'record, which is what an untouched character looks like. Gear is a count; hover it ' +
        'for the item and art names.'),
      h('p', { className: 'init-score' }, scoreText),
      h('p', { className: 'init-prediction' }, predictionText),
      gapKeys.length
        ? h('p', { className: 'hint' },
            'Source record gaps: ' + gapKeys.map(function (key) {
              return key + ' lacks INIT ' + (gaps[key] || []).join(' and ');
            }).join('; ') + '.')
        : null,
      blocks
    );
  }

  function buildDetail(vm, resolver, options) {
    if (!vm) {
      return h('p', { className: 'empty' }, 'This slot has no inner save data.');
    }

    options = options || {};
    // Default to the party leader so the panel is populated on first render.
    var selectedChr = options.selectedCharacter;
    if (selectedChr === null || selectedChr === undefined) selectedChr = vm.party.heroNo;
    // opts.scroll === false keeps the page where it is: arrow-key browsing must
    // not throw you down to the card on every keypress.
    var selectCharacter = function (chrNo, opts) {
      if (typeof options.onSelectCharacter === 'function') options.onSelectCharacter(chrNo, opts);
    };

    var leader = resolver.character(vm.party.heroNo);
    var teamIds = (vm.party.team || []).filter(function (id) {
      return id !== null && id !== SENTINELS.character;
    });

    var party = h('section', { className: 'card', id: 'party', 'data-index-label': 'Party' },
      h('h3', null, 'Party'),
      h('dl', { className: 'kv' },
        kv('Leader', nameWithBadge(leader, vm.party.heroNo)),
        kv('Party members', formatNumber(vm.party.count)),
        kv('Money', formatNumber(vm.money)),
        kv('Encounter rank (parLev)', encounterRankLabel(vm.encounterRank)),
        kv('Slot character', vm.meta && vm.meta.characterName ? vm.meta.characterName : '-')
      ),
      h('p', { className: 'hint' },
        'This is the live value in pty.each.parLev, not a character level. The game never ' +
        'shows the raw number: it is the packed Battle Rank Points byte, 16 points per rank, ' +
        'with BR-1 in the high nibble. ' +
        'The separate scenario-clear record lives in the System file card and is shared by ' +
        'every slot in the file.'),
      h('h4', null, 'Active team order'),
      teamIds.length
        ? h('ul', { className: 'chips' }, teamIds.map(function (id) {
            return h('li', { className: 'chip' }, displayName(resolver.character(id), id));
          }))
        : h('p', { className: 'empty' }, 'No active team entries.')
    );

    var items = h('section', { className: 'card', id: 'items', 'data-index-label': 'Items' },
      h('h3', null, 'Item hex array (item_a)'),
      h('p', { className: 'hint' }, 'Item IDs resolved against docs/constants.json.'),
      vm.items.length
        ? h('div', { className: 'table-scroll' },
            h('table', { className: 'grid grid-item-hex' },
              h('thead', null, h('tr', null,
                h('th', null, '#'),
                h('th', null, 'Hex'),
                h('th', null, 'Item'),
                h('th', null, 'Qty')
              )),
              h('tbody', null, vm.items.map(function (entry) {
                return h('tr', null,
                  h('td', { className: 'num' }, String(entry.index)),
                  h('td', { className: 'mono' }, hex2(entry.itemNo)),
                  h('td', null, nameWithBadge(resolver.item(entry.itemNo), entry.itemNo)),
                  h('td', { className: 'num' }, formatNumber(entry.count))
                );
              }))
            )
          )
        : h('p', { className: 'empty' }, 'No items held.')
    );

    var stat = function (pair) {
      return (pair[0] === null ? '-' : pair[0]) + '/' + (pair[1] === null ? '-' : pair[1]);
    };

    var roster = h('section', { className: 'card card-wide', id: 'roster', 'data-index-label': 'Roster' },
      h('h3', null, 'Character roster', h('span', { className: 'count' }, ' ' + vm.counters.rosterCount + ' records')),
      h('p', { className: 'hint' }, 'Roster presence is not party membership. Every character is stored in every save. ' +
        'Select a row to open that character\u2019s detail below; arrow keys browse the rows without leaving the table.'),
      h('div', { className: 'table-scroll' },
        h('table', { className: 'grid grid-roster' },
          h('thead', null, h('tr', null,
            h('th', null, 'chr'),
            h('th', null, 'Name'),
            h('th', null, 'HP'),
            h('th', null, 'LP'),
            h('th', null, 'WP'),
            h('th', null, 'JP'),
            STAT_FIELDS.map(function (field) {
              return h('th', null, field.code);
            }),
            h('th', null, 'ATK'),
            h('th', null, 'ITM'),
            h('th', null, 'SKL')
          )),
          h('tbody', null, vm.roster.map(function (record, rowIndex) {
            var isSelected = record.chrNo === selectedChr;
            var label = displayName(resolver.character(record.chrNo), record.chrNo);
            // The row is a pointer convenience; the button in the name cell is
            // the accessible control, so the row keeps its table semantics.
            return h('tr', {
              className: 'row-selectable' + (isSelected ? ' is-selected-row' : ''),
              title: 'Show full detail for ' + label,
              onClick: function () { selectCharacter(record.chrNo); }
            },
              h('td', { className: 'mono', 'data-label': 'CHR' }, hex2(record.chrNo)),
              h('td', { 'data-label': 'Name' }, h('button', {
                type: 'button',
                className: 'row-select',
                // Stable hook: focus is restored by character after a re-render.
                'data-chr': hex2(record.chrNo),
                'aria-pressed': isSelected ? 'true' : 'false',
                onClick: function (event) {
                  if (event && event.stopPropagation) event.stopPropagation();
                  selectCharacter(record.chrNo);
                },
                // Arrow keys browse the table without scrolling to the card;
                // Enter/Space stay the commit gesture and do scroll.
                onKeyDown: function (event) {
                  var target = rosterTargetFor(event.key, rowIndex, vm.roster.length);
                  if (target === null || target === rowIndex) {
                    if (target === rowIndex && event.preventDefault) event.preventDefault();
                    return;
                  }
                  event.preventDefault();
                  selectCharacter(vm.roster[target].chrNo, { scroll: false });
                }
              }, nameWithBadge(resolver.character(record.chrNo), record.chrNo))),
              h('td', { className: 'num', 'data-label': 'HP' }, formatNumber(record.hpMax)),
              h('td', { className: 'num', 'data-label': 'LP' }, stat(record.lp)),
              h('td', { className: 'num', 'data-label': 'WP' }, stat(record.wp)),
              h('td', { className: 'num', 'data-label': 'JP' }, stat(record.jp)),
              STAT_FIELDS.map(function (field) {
                return h('td', { className: 'num', 'data-label': field.code },
                  formatNumber(record.stats[field.key]));
              }),
              h('td', { className: 'num', 'data-label': 'ATK' }, String(record.equipAttack.length)),
              h('td', { className: 'num', 'data-label': 'ITM' }, String(record.equipItem.length)),
              h('td', { className: 'num', 'data-label': 'SKL' }, String(record.skills.length))
            );
          }))
        )
      )
    );

    var location = h('section', { className: 'card', id: 'location', 'data-index-label': 'Location' },
      h('h3', null, 'Location'),
      h('dl', { className: 'kv' },
        kv('Current map', mapLabel(vm.location.mapId, resolver)),
        kv('Map file', vm.location.imfName || '-'),
        kv('Area id', areaLabel(vm.location.mapName, resolver)),
        kv('Event map number', mapLabel(vm.location.mapNo, resolver)),
        kv('Position X / Z', formatNumber(vm.location.x) + ' / ' + formatNumber(vm.location.z)),
        kv('Direction', formatNumber(vm.location.dir)),
        kv('Region number', formatNumber(vm.location.regionNo))
      ),
      // The two other map-ish fields have misled a reader before; say what they
      // are instead of letting the numbers look like room ids.
      h('p', { className: 'hint' },
        'Current map comes from mapwk.imfName, the IMF map asset the game loaded. ' +
        'The area id (mapwk.map_name, mirrored by the slot MapNumber) indexes the ' +
        "game's area name table, so it names the region rather than the room. " +
        'eventwk.mapNo is the previous map, not the current one, and is shown for ' +
        'reference only.')
    );

    // Order matters for reading: everything that reacts to the roster selection
    // sits below the roster, so a row click updates content in view rather than
    // off-screen above it.
    return h('div', { className: 'detail-grid' },
      party, items, location,
      buildScenarioFlags(vm, resolver, options.flagMeanings),
      buildSystemFile(vm),
      buildShopRecord(vm, resolver, options),
      buildCharacterArrays(vm, resolver),
      buildAbilities(vm, resolver), roster,
      buildCharacterDetail(vm, resolver, selectedChr, options),
      buildAbilitySchools(vm, resolver, selectedChr),
      buildElementCoverage(vm, resolver, selectedChr),
      buildInitSets(vm, resolver, options && options.initSets));
  }

  // The page index is derived from the rendered cards, not from a second list
  // kept by hand: a card that is absent for this save (no system block, no
  // ability table) drops out of the index with it.
  function collectIndexEntries(node, out) {
    out = out || [];
    if (Array.isArray(node)) {
      node.forEach(function (child) { collectIndexEntries(child, out); });
      return out;
    }
    if (!node || typeof node !== 'object') return out;
    var props = node.props || {};
    if (props.id && props['data-index-label']) {
      out.push({ id: String(props.id), label: String(props['data-index-label']) });
    }
    (node.children || []).forEach(function (child) { collectIndexEntries(child, out); });
    return out;
  }

  // Tops are viewport-relative, in document order. The last section whose top
  // has reached the reading line is the one being read. Cards that share a
  // grid row have the same top: the first of the row wins, so jumping to the
  // left card does not light up the right one beside it.
  function activeIndexFor(tops, threshold) {
    if (!tops || !tops.length) return -1;
    var active = 0;
    for (var i = 0; i < tops.length; i++) {
      if (tops[i] <= threshold && tops[i] !== tops[active]) active = i;
    }
    return active;
  }

  function buildPageIndexItems(entries, onSelect) {
    return (entries || []).map(function (entry) {
      return h('li', { key: entry.id },
        h('a', {
          href: '#' + entry.id,
          className: 'page-index-link',
          'data-index-target': entry.id,
          onClick: function () {
            if (typeof onSelect === 'function') onSelect(entry.id);
          }
        }, entry.label)
      );
    });
  }

  function snapshotTime(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return String(iso || '');
    return date.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function buildSnapshotList(snapshots, onExport) {
    return (snapshots || []).map(function (record) {
      return h('li', { className: 'snapshot-item', 'data-snapshot': record.id },
        h('div', { className: 'snapshot-main' },
          h('span', { className: 'snapshot-time' }, snapshotTime(record.createdAt)),
          h('span', { className: 'snapshot-meta', title: record.fileName },
            formatNumber(record.bytes) + ' bytes' + (record.sourceName ? ' / ' + record.sourceName : ''))
        ),
        h('button', {
          type: 'button',
          className: 'snapshot-export',
          onClick: function () {
            if (typeof onExport === 'function') onExport(record);
          }
        }, 'Export')
      );
    });
  }

  /* ------------------------------------------------------------------ *
   * DOM mounting (browser only)
   * ------------------------------------------------------------------ */

  function mount(node, parent) {
    if (node === null || node === undefined || node === false) return;
    if (Array.isArray(node)) {
      node.forEach(function (child) { mount(child, parent); });
      return;
    }
    if (typeof node === 'string' || typeof node === 'number') {
      parent.appendChild(document.createTextNode(String(node)));
      return;
    }
    if (node.text !== undefined) {
      parent.appendChild(document.createTextNode(node.text));
      return;
    }
    var el = document.createElement(node.tag);
    var props = node.props || {};
    Object.keys(props).forEach(function (key) {
      var value = props[key];
      if (value === null || value === undefined || value === false) return;
      if (key === 'key') return; // list identity only, not a DOM attribute
      if (key === 'className') {
        el.className = String(value);
      } else if (key === 'onClick') {
        el.addEventListener('click', value);
      } else if (key === 'onKeyDown') {
        el.addEventListener('keydown', value);
      } else if (key === 'onToggle') {
        // <details> has no click-time truth: the open state changes after the
        // click, so the toggle event is the only reliable signal.
        el.addEventListener('toggle', function (event) {
          value(Boolean(el.open), event);
        });
      } else if (key === 'disabled') {
        el.disabled = Boolean(value);
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    });
    (node.children || []).forEach(function (child) { mount(child, el); });
    parent.appendChild(el);
  }

  /* ------------------------------------------------------------------ *
   * UI controller
   * ------------------------------------------------------------------ */

  function createApp(dom) {
    // The header stamp is the quickest way to tell a stale tab from a fresh
    // one. index.html carries the same text statically for a failed script load.
    if (dom.buildStamp) dom.buildStamp.textContent = 'Build ' + BUILD;

    var state = {
      fileName: '',
      byteLength: 0,
      sha256: null,
      container: null,
      slots: [],
      // The filter only changes which rows the pager walks over; the file is
      // untouched and the selection survives the toggle.
      populatedOnly: false,
      selected: null,
      selectedCharacter: null,
      slotCache: {},
      inspection: null,
      roundTrip: null,
      constants: null,
      constantsError: null,
      abilities: null,
      abilitiesError: null,
      maps: null,
      mapsError: null,
      flags: null,
      flagsError: null,
      flagMeanings: null,
      flagMeaningsError: null,
      initSets: null,
      initSetsError: null,
      itemStats: null,
      itemStatsError: null,
      mysticAbsorbs: null,
      mysticAbsorbsError: null,
      monsterForms: null,
      monsterFormsError: null,
      shopNames: null,
      shopNamesError: null,
      // Which still-to-buy stops are expanded, by location name. Survives slot
      // switches because the shop ledger is per file, not per slot.
      shopOpen: {},
      payloadBytes: null,
      containerKind: null,
      originalIntact: null,
      // Page index: derived from the rendered cards, plus the DOM id that the
      // scroll-spy currently marks. Never a hand-kept copy of the card list.
      indexEntries: [],
      indexTimer: null,
      indexClickAt: 0,
      // Layout B: the rail can show one character summary in place of the page
      // index. The summary never adds a third sidebar panel.
      railCharacterOpen: false,
      railCharacterAvailable: false,
      // Browser live-folder state. The adapter owns the handle and the polling;
      // this only tracks what the UI should say and whether a refresh is due.
      live: {
        available: false,
        connected: false,
        folderName: '',
        permission: 'unknown',
        watching: false,
        stopWatch: null,
        settings: Object.assign({}, LIVE_DEFAULT_SETTINGS),
        busy: false,
        controlBusy: false,
        queued: false,
        pendingChange: false,
        lastRead: null,
        snapshots: []
      },
      lastModified: null,
      pending: null
    };

    function setStatus(message, kind) {
      if (!dom.status) return;
      dom.status.hidden = !message;
      dom.status.className = 'status' + (kind ? ' status-' + kind : '');
      dom.status.textContent = message || '';
    }

    function pageSlots() {
      return slotsForFilter(state.slots, state.populatedOnly);
    }

    function renderSlotList() {
      if (!dom.slotList) return;
      var visible = pageSlots();
      var bounds = slotPageBounds(visible.length, state.slotPage);
      state.slotPage = bounds.page;
      if (dom.slotPopulated) {
        dom.slotPopulated.disabled = state.slots.length === 0;
        dom.slotPopulated.checked = Boolean(state.populatedOnly);
      }
      dom.slotList.innerHTML = '';
      mount(buildSlotPicker(
        visible,
        state.selected ? state.selected.key : null,
        selectSlot,
        makeResolver(state.constants, state.abilities, state.maps, state.flags, state.shopNames, state.itemStats, state.mysticAbsorbs, state.monsterForms)
      ), dom.slotList);
      // Hide the rows outside the page on the mounted <li>s. The whole picker
      // stays in the DOM so the selection and the row titles survive paging.
      var list = dom.slotList.children && dom.slotList.children[0];
      if (list && list.children) {
        Array.prototype.forEach.call(list.children, function (item, index) {
          item.hidden = index < bounds.start || index >= bounds.end;
        });
      }
      if (dom.slotFast) {
        dom.slotFast.innerHTML = '';
        mount(buildFastSlots(
          state.slots,
          state.selected ? state.selected.key : null,
          selectSlot,
          makeResolver(state.constants, state.abilities, state.maps, state.flags, state.shopNames, state.itemStats, state.mysticAbsorbs, state.monsterForms)
        ), dom.slotFast);
      }
      updateSlotPager(bounds);
    }

    function updateSlotPager(bounds) {
      if (dom.slotPageStatus) {
        dom.slotPageStatus.textContent = bounds.end > bounds.start
          ? bounds.start + '-' + (bounds.end - 1) + ' of ' + bounds.total
          : 'No slots';
      }
      if (dom.slotPrev) dom.slotPrev.disabled = bounds.page <= 0;
      if (dom.slotNext) {
        dom.slotNext.disabled = !bounds.total || bounds.page >= bounds.pages - 1;
      }
    }

    function indexLinks(list) {
      if (!list) return [];
      if (typeof list.querySelectorAll === 'function') {
        return Array.prototype.slice.call(list.querySelectorAll('[data-index-target]'));
      }
      var out = [];
      (list.children || []).forEach(function (li) {
        (li.children || []).forEach(function (link) {
          if (link && link.attributes && link.attributes['data-index-target']) out.push(link);
        });
      });
      return out;
    }

    function attrOf(el, name) {
      if (!el) return null;
      if (typeof el.getAttribute === 'function') return el.getAttribute(name);
      return el.attributes ? el.attributes[name] : null;
    }

    function setActiveIndex(id) {
      [dom.pageIndexList, dom.pageIndexMobileList].forEach(function (list) {
        indexLinks(list).forEach(function (link) {
          var active = attrOf(link, 'data-index-target') === id;
          if (link.classList) {
            if (active) link.classList.add('is-active');
            else link.classList.remove('is-active');
          }
          if (active) link.setAttribute('aria-current', 'location');
          else if (typeof link.removeAttribute === 'function') link.removeAttribute('aria-current');
        });
      });
    }

    // A timer, not requestAnimationFrame: an occluded or background tab can
    // leave an rAF callback pending, freezing the rail on an old section. Fifty
    // milliseconds coalesces scroll bursts and still runs in the background.
    function scheduleIndexUpdate() {
      if (!state.indexEntries.length) return;
      // An anchor jump fires scroll immediately after the click. Give the
      // clicked link a short hold so a card sharing its grid row (Party and
      // Items) cannot steal the marker the user just chose.
      if (Date.now() - state.indexClickAt < 400) return;
      if (state.indexTimer) return;
      state.indexTimer = setTimeout(function () {
        state.indexTimer = null;
        updateActiveIndex();
      }, 50);
    }

    function updateActiveIndex() {
      if (!state.indexEntries.length) return;
      if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
      var tops = [];
      var ids = [];
      state.indexEntries.forEach(function (entry) {
        var el = document.getElementById(entry.id);
        if (!el || typeof el.getBoundingClientRect !== 'function') return;
        tops.push(el.getBoundingClientRect().top);
        ids.push(entry.id);
      });
      if (!tops.length) return;
      var atBottom = typeof window !== 'undefined' && typeof document.documentElement !== 'undefined' &&
        document.documentElement.scrollHeight - (window.scrollY || 0) - (window.innerHeight || 0) < 8;
      var index = atBottom ? ids.length - 1 : activeIndexFor(tops, 96);
      setActiveIndex(ids[index]);
    }

    function bindPageIndex() {
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('scroll', scheduleIndexUpdate, { passive: true });
        window.addEventListener('resize', scheduleIndexUpdate);
      }
      if (dom.detail && typeof dom.detail.addEventListener === 'function') {
        // toggle does not bubble; capture catches the flag and shop details too.
        dom.detail.addEventListener('toggle', scheduleIndexUpdate, true);
      }
      if (dom.pageIndexMobile && typeof dom.pageIndexMobile.addEventListener === 'function') {
        dom.pageIndexMobile.addEventListener('toggle', scheduleIndexUpdate);
      }
    }

    // A width check, not a media query, so the controller follows the CSS:
    // the rail is hidden below 860px and the phone path keeps the old scroll
    // behavior. The harness can drive this by stubbing the panel width.
    function pageIndexVisible() {
      if (!dom.pageIndex || typeof dom.pageIndex.getBoundingClientRect !== 'function') return false;
      var rect = dom.pageIndex.getBoundingClientRect();
      return Boolean(rect && rect.width > 0);
    }

    function renderRailView() {
      var open = Boolean(state.railCharacterOpen && state.railCharacterAvailable);
      if (dom.pageIndexView) dom.pageIndexView.hidden = open;
      if (dom.characterRail) dom.characterRail.hidden = !open;
      if (dom.characterOpen) {
        dom.characterOpen.disabled = !state.railCharacterAvailable;
        dom.characterOpen.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
    }

    function openCharacterRail(focusBack) {
      if (!state.railCharacterAvailable) return;
      state.railCharacterOpen = true;
      renderRailView();
      if (focusBack && dom.characterRailBack &&
          typeof dom.characterRailBack.focus === 'function') {
        dom.characterRailBack.focus({ preventScroll: true });
      }
    }

    function closeCharacterRail(returnFocus) {
      if (!state.railCharacterOpen) return;
      state.railCharacterOpen = false;
      renderRailView();
      // The index was hidden while the summary was open; sync the marker to
      // wherever the page actually is before handing it back.
      updateActiveIndex();
      if (returnFocus && dom.characterOpen &&
          typeof dom.characterOpen.focus === 'function') {
        dom.characterOpen.focus({ preventScroll: true });
      }
    }

    // Built from the same vm and resolver as the wide card, so the rail cannot
    // disagree with the page. A missing record clears the summary and closes
    // the drill-over.
    function renderCharacterRail(vm, resolver, chrNo) {
      if (!dom.characterRailBody) return;
      dom.characterRailBody.innerHTML = '';
      var node = vm ? buildCharacterRail(vm, resolver, chrNo) : null;
      state.railCharacterAvailable = Boolean(node);
      if (node) mount(node, dom.characterRailBody);
      if (!node) state.railCharacterOpen = false;
      renderRailView();
    }

    // The rail is built from the cards that actually rendered. A card absent
    // from this save (no system block, no ability table) is absent here too.
    function renderPageIndex(entries) {
      state.indexEntries = entries || [];
      var hasEntries = state.indexEntries.length > 0;
      if (dom.pageIndexHint) {
        dom.pageIndexHint.hidden = hasEntries;
        // A loaded save can still land on an empty slot; do not tell the user
        // to load a file they already loaded.
        if (!hasEntries) {
          dom.pageIndexHint.textContent = state.selected
            ? 'This slot has no sections.'
            : 'Load a save to see the sections.';
        }
      }
      if (dom.pageIndexList) {
        dom.pageIndexList.innerHTML = '';
        dom.pageIndexList.hidden = !hasEntries;
      }
      if (dom.pageIndexMobile) dom.pageIndexMobile.hidden = !hasEntries;
      if (dom.pageIndexMobileList) dom.pageIndexMobileList.innerHTML = '';
      if (!hasEntries) {
        setActiveIndex(null);
        return;
      }
      var items = buildPageIndexItems(state.indexEntries, function (id) {
        setActiveIndex(id);
        state.indexClickAt = Date.now();
        if (dom.pageIndexMobile) dom.pageIndexMobile.open = false;
      });
      if (dom.pageIndexList) mount(items, dom.pageIndexList);
      if (dom.pageIndexMobileList) mount(items, dom.pageIndexMobileList);
      updateActiveIndex();
    }

    // Scrolling is tied to selection only: loading a slot must never move the
    // page, or opening a save would jump straight past the file summary.
    function scrollCharacterIntoView() {
      if (!dom.detail || typeof dom.detail.querySelector !== 'function') return;
      var card = dom.detail.querySelector('#character-detail');
      if (!card || typeof card.scrollIntoView !== 'function') return;
      var reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      card.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    }

    // A selection re-renders the whole detail tree, which destroys the button
    // that had focus and drops it to <body>. Hand it back to the equivalent
    // control so a keyboard user keeps their place in the roster.
    // preventScroll matters: the row is above the card we just scrolled to.
    // preventScroll is true on the click path, where the card is scrolled into
    // view right afterwards; arrow browsing passes false so the browser keeps
    // the focused row on screen while the page stays off the card.
    function focusCharacterControl(preventScroll) {
      if (!dom.detail || typeof dom.detail.querySelector !== 'function') return;
      var chr = state.selectedCharacter;
      if (chr === null || chr === undefined) return;
      var target = dom.detail.querySelector('.grid-roster button[data-chr="' + hex2(chr) + '"]');
      if (!target || typeof target.focus !== 'function') return;
      target.focus({ preventScroll: Boolean(preventScroll) });
    }

    // scrollToCharacter brings the card into view; refocus hands focus back to
    // the row control, which the re-render destroys. They are separate because
    // arrow-key browsing refocuses without scrolling to the card.
    function renderDetail(scrollToCharacter, refocus) {
      if (refocus === undefined) refocus = Boolean(scrollToCharacter);
      if (!dom.detail) return;
      dom.detail.innerHTML = '';
      if (!state.selected || !state.container) {
        mount(h('p', { className: 'empty' }, 'Select a slot to inspect it.'), dom.detail);
        renderPageIndex([]);
        renderCharacterRail(null);
        return;
      }
      try {
        var cached = state.slotCache[state.selected.key];
        if (!cached) {
          cached = parseSlot(state.container, state.selected);
          state.slotCache[state.selected.key] = cached;
        }
        if (cached.empty) {
          mount(h('p', { className: 'empty' }, 'This slot has no inner save data.'), dom.detail);
          renderPageIndex([]);
          renderCharacterRail(null);
          return;
        }
        var vm = buildViewModel(cached.data, state.selected, state.container.systemSaveData);
        var resolver = makeResolver(state.constants, state.abilities, state.maps, state.flags,
          state.shopNames, state.itemStats, state.mysticAbsorbs, state.monsterForms);
        var selectedChr = state.selectedCharacter;
        if (selectedChr === null || selectedChr === undefined) selectedChr = vm.party.heroNo;
        // A preserved character may not exist in a different save. Fall back
        // to the leader rather than rendering an empty character detail.
        if (!rosterRecordFor(vm, selectedChr)) selectedChr = vm.party.heroNo;
        var tree = buildDetail(vm, resolver, {
          selectedCharacter: selectedChr,
          initSets: state.initSets,
          flagMeanings: state.flagMeanings,
          openLocations: state.shopOpen,
          shopTableError: state.shopNamesError,
          itemStatsError: state.itemStatsError,
          mysticAbsorbError: state.mysticAbsorbsError,
          monsterFormsError: state.monsterFormsError,
          onShopToggle: function (location, isOpen) {
            if (isOpen) state.shopOpen[location] = true;
            else delete state.shopOpen[location];
            scheduleIndexUpdate();
          },
          onSelectCharacter: function (chrNo, opts) {
            state.selectedCharacter = chrNo;
            var keepPage = Boolean(opts && opts.scroll === false);
            if (pageIndexVisible()) {
              // The compact summary is the immediate feedback on desktop, so
              // selection does not jump the page down to the wide card. Focus
              // is handed back to the same roster row by renderDetail.
              state.railCharacterOpen = true;
              renderDetail(false, true);
            } else {
              state.railCharacterOpen = false;
              renderDetail(!keepPage, true);
            }
          }
        });
        mount(tree, dom.detail);
        renderPageIndex(collectIndexEntries(tree));
        renderCharacterRail(vm, resolver, selectedChr);
        if (refocus) focusCharacterControl(scrollToCharacter);
        if (scrollToCharacter) scrollCharacterIntoView();
      } catch (err) {
        mount(h('p', { className: 'error' }, err.message), dom.detail);
        renderPageIndex([]);
        renderCharacterRail(null);
      }
    }

    function renderInspector() {
      if (!dom.byteInspector) return;
      dom.byteInspector.innerHTML = '';
      var inspection = state.inspection
        ? Object.assign({}, state.inspection, { roundTrip: state.roundTrip })
        : null;
      mount(buildByteInspector(inspection), dom.byteInspector);
    }

    function renderFileInfo() {
      if (!dom.fileInfo) return;
      dom.fileInfo.innerHTML = '';
      mount(buildFileInfo(state.fileName, state.byteLength, state.sha256, state.originalIntact,
        state.payloadBytes, state.containerKind), dom.fileInfo);
    }

    function selectSlot(slot, options) {
      if (!slot || !slot.hasData) return;
      options = options || {};
      // A selection can arrive from ingest rather than a click, so bring its
      // page into view instead of assuming the picker is already there.
      var at = pageSlots().indexOf(slot);
      if (at !== -1) state.slotPage = Math.floor(at / SLOT_PAGE_SIZE);
      state.selected = slot;
      state.selectedCharacter = options.character === undefined ? null : options.character;
      state.railCharacterOpen = false;
      renderSlotList();
      renderDetail();
    }

    async function fetchJson(path) {
      var response = await fetch(path, { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    }

    // The three name tables load independently: a missing ability or map table
    // must not stop character and item names from resolving.
    async function loadConstants() {
      var problems = [];
      try {
        state.constants = await fetchJson(tableUrl(CONSTANTS_PATH));
      } catch (err) {
        state.constants = null;
        problems.push('Could not load ' + CONSTANTS_PATH + ' (' + err.message + ')');
      }
      try {
        state.abilities = await fetchJson(tableUrl(ABILITY_PATH));
        state.abilitiesError = null;
      } catch (err) {
        state.abilities = null;
        state.abilitiesError = 'Could not load ' + ABILITY_PATH + ' (' + err.message + ')';
        problems.push(state.abilitiesError);
      }
      try {
        state.maps = await fetchJson(tableUrl(MAP_PATH));
        state.mapsError = null;
      } catch (err) {
        state.maps = null;
        state.mapsError = 'Could not load ' + MAP_PATH + ' (' + err.message + ')';
        problems.push(state.mapsError);
      }
      try {
        state.flags = await fetchJson(tableUrl(FLAG_PATH));
        state.flagsError = null;
      } catch (err) {
        state.flags = null;
        state.flagsError = 'Could not load ' + FLAG_PATH + ' (' + err.message + ')';
        problems.push(state.flagsError);
      }
      try {
        state.flagMeanings = await fetchJson(tableUrl(FLAG_EN_PATH));
        state.flagMeaningsError = null;
      } catch (err) {
        state.flagMeanings = null;
        state.flagMeaningsError = 'Could not load ' + FLAG_EN_PATH + ' (' + err.message + ')';
        problems.push(state.flagMeaningsError);
      }
      try {
        state.initSets = await fetchJson(tableUrl(INIT_PATH));
        state.initSetsError = null;
      } catch (err) {
        state.initSets = null;
        state.initSetsError = 'Could not load ' + INIT_PATH + ' (' + err.message + ')';
        problems.push(state.initSetsError);
      }
      try {
        state.itemStats = await fetchJson(tableUrl(ITEM_STATS_PATH));
        state.itemStatsError = null;
      } catch (err) {
        // Optional, like the flag glosses: a save from any other race renders
        // unchanged, and a Mec card names the missing table instead of adding
        // zeroes for parts it could not resolve.
        state.itemStats = null;
        state.itemStatsError = 'Could not load ' + ITEM_STATS_PATH + ' (' + err.message + ')';
      }
      try {
        state.mysticAbsorbs = await fetchJson(tableUrl(MYSTIC_ABSORB_PATH));
        state.mysticAbsorbsError = null;
      } catch (err) {
        // Optional: the panel still decodes the stored enemy id and boosts, and
        // names the missing table instead of inventing names or arts.
        state.mysticAbsorbs = null;
        state.mysticAbsorbsError = 'Could not load ' + MYSTIC_ABSORB_PATH + ' (' + err.message + ')';
      }
      try {
        state.monsterForms = await fetchJson(tableUrl(MONSTER_FORMS_PATH));
        state.monsterFormsError = null;
      } catch (err) {
        // Optional: a Monster card still shows the raw form id and Prime HP,
        // and names the missing table instead of inventing a form.
        state.monsterForms = null;
        state.monsterFormsError = 'Could not load ' + MONSTER_FORMS_PATH + ' (' + err.message + ')';
      }
      try {
        state.shopNames = await fetchJson(tableUrl(SHOP_PATH));
        state.shopNamesError = null;
      } catch (err) {
        state.shopNames = null;
        state.shopNamesError = 'Could not load ' + SHOP_PATH + ' (' + err.message + ')';
        problems.push(state.shopNamesError);
      }
      if (problems.length) {
        state.constantsError = problems.join('. ') +
          '. Unresolved ids are shown raw. If you opened this page from disk, serve it over http.';
      } else {
        state.constantsError = null;
      }
    }

    // The one ingest path shared by the file input, drag/drop and SaveSource.
    // It takes bytes that were already read once, so a watcher refresh never
    // goes through FileReader and never gets a second copy of the file.
    async function ingestBytes(buffer, name, lastModified, options) {
      if (!buffer) return;
      options = options || {};
      var inputName = name || 'SaveData.bin';
      var previousKey = state.selected ? state.selected.key : null;
      var previousCharacter = state.selectedCharacter;
      setStatus('Reading ' + inputName + ' ...', 'busy');

      // 1. Preserve the pristine bytes before anything parses them. The
      //    previous good backup is held aside so a corrupt file cannot evict it.
      var previous = global.originalSaveData || null;
      var pristine = cloneBuffer(buffer);
      publishOriginal(pristine);

      var hash;
      var container;
      var text;
      var decoded = null;
      try {
        // 3. Parse a separate copy. The original is never passed downstream.
        var working = cloneBuffer(pristine);
        hash = await sha256Hex(pristine);

        // 4. Inspect and parse the working copy. A real SaveData.bin is raw
        //    DEFLATE, so the container is inflated before the JSON is read; an
        //    already-inflated .json mirror takes the same path with no change.
        decoded = await decodeSavePayload(working);
        text = decoded.text;
        container = parseContainer(text);
        state.inspection = inspectBytes(working, text, {
          containerKind: decoded.containerKind,
          payload: decoded.payload
        });
        state.payloadBytes = decoded.payload.byteLength;
        state.containerKind = decoded.containerKind;
        working = null;
      } catch (err) {
        if (previous) {
          publishOriginal(previous);
        } else {
          publishOriginal(null);
        }
        throw err;
      }

      state.fileName = inputName;
      state.lastModified = lastModified || null;
      state.byteLength = pristine.byteLength;
      state.sha256 = hash;
      state.container = container;
      state.slots = listSlots(container);
      state.slotPage = 0;
      state.slotCache = {};
      // A different file has different progress and may lack a location, so a
      // remembered open stop must not leak across saves.
      state.shopOpen = {};
      state.selected = null;
      state.railCharacterOpen = false;
      state.originalIntact = null;
      state.roundTrip = null;

      // 5. Prove the pristine buffer did not move.
      var after = await sha256Hex(global.originalSaveData);
      state.originalIntact = (hash === null || after === null) ? null : hash === after;

      // 6. Prove the write path reproduces these bytes exactly.
      var firstPopulated = state.slots.filter(function (slot) { return slot.hasData; })[0] || null;
      try {
        state.roundTrip = firstPopulated
          ? proveRoundTrip(decoded ? decoded.payload : pristine, text, container,
              firstPopulated, state.containerKind)
          : null;
      } catch (err) {
        state.roundTrip = null;
      }

      if (dom.dataContainer) dom.dataContainer.hidden = false;
      renderFileInfo();
      renderInspector();
      renderSlotList();

      var first = state.slots.filter(function (slot) { return slot.hasData; })[0] || null;
      if (first) {
        selectSlot(first);
      } else {
        renderDetail();
      }

      // A live refresh keeps the slot and character the user was inspecting.
      // This runs after the normal first-slot render so a missing old slot
      // still falls back to the first populated one instead of blanking.
      if (options.preserveSelection && previousKey) {
        var matching = null;
        state.slots.forEach(function (slot) {
          if (!matching && slot.key === previousKey && slot.hasData) matching = slot;
        });
        if (matching) selectSlot(matching, { character: previousCharacter });
      }

      setStatus('Loaded ' + inputName + ' - ' + state.slots.length + ' slot entries. Read-only.', 'ok');
      return state;
    }

    async function ingestFile(file) {
      if (!file) return;
      var buffer = await readFileAsArrayBuffer(file);
      return ingestBytes(buffer, file.name, file.lastModified);
    }

    function handleFile(file) {
      if (!file) return Promise.resolve();
      state.pending = ingestFile(file).catch(function (err) {
        if (dom.dataContainer) dom.dataContainer.hidden = true;
        setStatus(err.message, 'error');
        throw err;
      });
      // The error is surfaced in the UI; keep the chain from becoming unhandled
      // when no caller awaits it.
      state.pending.catch(function () {});
      return state.pending;
    }

    /* ------------------------------------------------------------------ *
     * Live save folder (browser SaveSource adapter)
     * ------------------------------------------------------------------ */

    function liveSource() {
      var source = global.SaveSource;
      if (!source || !source.capabilities || !source.capabilities.directory) return null;
      return source;
    }

    function loadLiveSettings() {
      try {
        if (!global.localStorage) return sanitizeLiveSettings(null);
        return sanitizeLiveSettings(JSON.parse(global.localStorage.getItem(LIVE_SETTINGS_KEY)));
      } catch (err) {
        return sanitizeLiveSettings(null);
      }
    }

    function saveLiveSettings() {
      try {
        if (global.localStorage) {
          global.localStorage.setItem(LIVE_SETTINGS_KEY, JSON.stringify(state.live.settings));
        }
      } catch (err) {
        // Private browsing can refuse storage. The current session still works.
      }
    }

    function liveMessage(message, kind) {
      if (!dom.liveStatus) return;
      dom.liveStatus.hidden = !message;
      dom.liveStatus.className = 'live-status' + (kind ? ' live-status-' + kind : '');
      dom.liveStatus.textContent = message || '';
    }

    function setLiveBusy(busy) {
      state.live.controlBusy = Boolean(busy);
      [dom.livePick, dom.liveReconnect, dom.liveReload].forEach(function (button) {
        if (!button) return;
        button.disabled = state.live.controlBusy;
      });
    }

    function renderLive() {
      var live = state.live;
      if (!dom.liveSave) return;
      dom.liveSave.hidden = !live.available;
      if (!live.available) return;
      if (dom.liveState) {
        var label = 'Not connected';
        if (live.connected && live.watching) label = 'Watching';
        else if (live.connected) label = 'Connected';
        else if (live.folderName && live.permission === 'prompt') label = 'Reconnect needed';
        else if (live.permission === 'denied') label = 'Permission denied';
        dom.liveState.textContent = label;
        dom.liveState.className = 'live-state' +
          (live.connected ? ' is-connected' : '') +
          (live.watching ? ' is-watching' : '');
      }
      if (dom.livePick) {
        dom.livePick.textContent = live.connected || live.folderName ? 'Change folder' : 'Choose folder';
      }
      if (dom.liveReconnect) {
        dom.liveReconnect.hidden = !(live.folderName &&
          (live.permission === 'prompt' || live.permission === 'denied'));
      }
      if (dom.liveReload) {
        dom.liveReload.hidden = !live.connected;
        dom.liveReload.disabled = live.busy || live.controlBusy;
      }
      if (dom.liveWatch) dom.liveWatch.checked = live.settings.watch;
      if (dom.liveAuto) dom.liveAuto.checked = live.settings.autoReload;
      if (dom.liveInterval) dom.liveInterval.value = String(live.settings.interval);
      if (dom.liveSnapshots) dom.liveSnapshots.checked = live.settings.snapshots;
      if (dom.liveRetention) dom.liveRetention.value = String(live.settings.retention);
      if (dom.snapshotBlock) {
        dom.snapshotBlock.hidden = !live.settings.snapshots && live.snapshots.length === 0;
      }
    }

    function renderSnapshots() {
      if (!dom.snapshotList) return;
      dom.snapshotList.innerHTML = '';
      mount(buildSnapshotList(state.live.snapshots, exportSnapshot), dom.snapshotList);
      if (dom.snapshotEmpty) dom.snapshotEmpty.hidden = state.live.snapshots.length > 0;
      if (dom.snapshotCount) {
        dom.snapshotCount.textContent = state.live.snapshots.length
          ? String(state.live.snapshots.length)
          : '';
      }
      if (dom.snapshotBlock) {
        dom.snapshotBlock.hidden = !state.live.settings.snapshots && state.live.snapshots.length === 0;
      }
    }

    async function refreshSnapshots() {
      var source = liveSource();
      if (!source || typeof source.listSnapshots !== 'function') return;
      try {
        state.live.snapshots = await source.listSnapshots();
      } catch (err) {
        state.live.snapshots = [];
      }
      renderSnapshots();
    }

    function stopLiveWatch() {
      if (state.live.stopWatch) {
        try { state.live.stopWatch(); } catch (err) { /* already stopped */ }
      }
      state.live.stopWatch = null;
      state.live.watching = false;
    }

    function startLiveWatch(announce) {
      stopLiveWatch();
      var source = liveSource();
      if (!source || typeof source.watch !== 'function' ||
          !state.live.connected || !state.live.settings.watch) {
        renderLive();
        return;
      }
      var shouldAnnounce = announce !== false;
      try {
        state.live.stopWatch = source.watch(function () {
          state.live.pendingChange = true;
          if (!state.live.settings.autoReload) {
            liveMessage('SaveData.bin changed. Use Reload now when you are ready.', 'warn');
            renderLive();
            return;
          }
          refreshFromFolder({ reason: 'change', preserveSelection: true });
        }, {
          interval: state.live.settings.interval,
          baseline: state.live.lastRead,
          onError: function (err) {
            liveMessage('Watcher error: ' + err.message, 'error');
          }
        });
        state.live.watching = true;
        if (shouldAnnounce) {
          liveMessage('Watching SaveData.bin every ' +
            (state.live.settings.interval / 1000) + ' seconds. Nothing is written to the folder.', 'ok');
        }
      } catch (err) {
        state.live.watching = false;
        liveMessage('Could not start the watcher: ' + err.message, 'error');
      }
      renderLive();
    }

    async function refreshFromFolder(options) {
      options = options || {};
      if (!state.live.connected) return false;
      if (state.live.busy) {
        state.live.queued = true;
        return false;
      }
      var source = liveSource();
      if (!source) return false;
      state.live.busy = true;
      var loaded = false;
      renderLive();
      try {
        var read = await source.read();
        state.live.lastRead = { size: read.size, lastModified: read.lastModified };
        state.live.permission = 'granted';
        await ingestBytes(read.buffer, read.name, read.lastModified, {
          preserveSelection: options.preserveSelection !== false
        });
        state.live.pendingChange = false;
        if (state.live.settings.snapshots && typeof source.saveSnapshot === 'function') {
          try {
            await source.saveSnapshot({
              buffer: read.buffer,
              name: read.name,
              bytes: read.size,
              sha256: state.sha256
            }, state.live.settings.retention);
            await refreshSnapshots();
          } catch (snapshotError) {
            liveMessage('Loaded the save, but the snapshot failed: ' + snapshotError.message, 'warn');
          }
        }
        loaded = true;
        if (options.reason === 'change' || options.reason === 'manual') {
          liveMessage('Reloaded SaveData.bin - ' + formatNumber(read.size) + ' bytes.', 'ok');
        }
      } catch (err) {
        setStatus(err.message, 'error');
        liveMessage('Could not read SaveData.bin: ' + err.message, 'error');
      } finally {
        state.live.busy = false;
        renderLive();
        if (state.live.queued) {
          state.live.queued = false;
          refreshFromFolder({ reason: 'queued', preserveSelection: true });
        }
      }
      return loaded;
    }

    function applyLiveConnection(info) {
      state.live.connected = Boolean(info && info.connected);
      state.live.permission = info && info.permission ? info.permission : 'unknown';
      state.live.folderName = info && info.name ? info.name : '';
      renderLive();
    }

    async function chooseLiveFolder() {
      var source = liveSource();
      if (!source) return;
      setLiveBusy(true);
      liveMessage('Choose the folder that contains SaveData.bin.', 'busy');
      try {
        var info = await source.pick();
        applyLiveConnection(info);
        if (!info.connected) {
          liveMessage('Read permission is required to watch the folder.', 'warn');
          return;
        }
        var loaded = await refreshFromFolder({ reason: 'pick', preserveSelection: false });
        startLiveWatch(loaded);
      } catch (err) {
        if (err && err.name === 'AbortError') {
          liveMessage('Folder selection cancelled.', '');
        } else {
          liveMessage('Could not open the folder: ' + err.message, 'error');
        }
      } finally {
        setLiveBusy(false);
        renderLive();
      }
    }

    async function reconnectLiveFolder() {
      var source = liveSource();
      if (!source) return;
      setLiveBusy(true);
      liveMessage('Requesting read permission for the save folder.', 'busy');
      try {
        var info = await source.reconnect();
        if (!info) {
          liveMessage('No saved folder was found. Choose the folder again.', 'warn');
          return;
        }
        applyLiveConnection(info);
        if (!info.connected) {
          liveMessage('Read permission was not granted. Choose the folder again or allow access.', 'warn');
          return;
        }
        var loaded = await refreshFromFolder({ reason: 'reconnect', preserveSelection: false });
        startLiveWatch(loaded);
      } catch (err) {
        liveMessage('Could not reconnect: ' + err.message, 'error');
      } finally {
        setLiveBusy(false);
        renderLive();
      }
    }

    async function reloadLiveSave() {
      if (!state.live.connected || state.live.busy) return;
      await refreshFromFolder({ reason: 'manual', preserveSelection: true });
    }

    async function exportSnapshot(record) {
      var source = liveSource();
      if (!source || typeof source.getSnapshot !== 'function') return;
      try {
        var full = await source.getSnapshot(record.id);
        if (!full || !full.buffer) throw new Error('Snapshot bytes are missing.');
        if (typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
          throw new Error('This browser cannot create a download.');
        }
        var url = URL.createObjectURL(new Blob([full.buffer], { type: 'application/octet-stream' }));
        var link = document.createElement('a');
        link.href = url;
        link.download = full.fileName || 'SaveData-snapshot.bin';
        link.rel = 'noopener';
        if (document.body) document.body.appendChild(link);
        link.click();
        if (document.body) document.body.removeChild(link);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        liveMessage('Exported ' + (full.fileName || 'snapshot') + '.', 'ok');
      } catch (err) {
        liveMessage('Could not export the snapshot: ' + err.message, 'error');
      }
    }

    function bindLiveControls() {
      if (state.live.bound) return;
      state.live.bound = true;
      if (dom.livePick) dom.livePick.addEventListener('click', chooseLiveFolder);
      if (dom.liveReconnect) dom.liveReconnect.addEventListener('click', reconnectLiveFolder);
      if (dom.liveReload) dom.liveReload.addEventListener('click', reloadLiveSave);
      if (dom.liveWatch) {
        dom.liveWatch.addEventListener('change', function () {
          state.live.settings.watch = Boolean(dom.liveWatch.checked);
          saveLiveSettings();
          if (state.live.settings.watch) startLiveWatch();
          else {
            stopLiveWatch();
            liveMessage('Watcher paused. Reload now still reads the folder.', 'warn');
            renderLive();
          }
        });
      }
      if (dom.liveAuto) {
        dom.liveAuto.addEventListener('change', function () {
          state.live.settings.autoReload = Boolean(dom.liveAuto.checked);
          saveLiveSettings();
          renderLive();
        });
      }
      if (dom.liveInterval) {
        dom.liveInterval.addEventListener('change', function () {
          state.live.settings.interval = Number(dom.liveInterval.value) || 2000;
          saveLiveSettings();
          if (state.live.settings.watch && state.live.connected) startLiveWatch();
        });
      }
      if (dom.liveSnapshots) {
        dom.liveSnapshots.addEventListener('change', function () {
          state.live.settings.snapshots = Boolean(dom.liveSnapshots.checked);
          saveLiveSettings();
          renderLive();
          if (state.live.settings.snapshots) refreshSnapshots();
        });
      }
      if (dom.liveRetention) {
        dom.liveRetention.addEventListener('change', function () {
          state.live.settings.retention = Number(dom.liveRetention.value) || 10;
          saveLiveSettings();
          var source = liveSource();
          if (source && typeof source.pruneSnapshots === 'function') {
            source.pruneSnapshots(state.live.settings.retention).then(refreshSnapshots, function () {});
          }
        });
      }
    }

    async function initLive() {
      if (!dom.liveSave) return;
      var source = liveSource();
      if (!source) {
        dom.liveSave.hidden = true;
        return;
      }
      state.live.available = true;
      state.live.settings = loadLiveSettings();
      stopLiveWatch();
      bindLiveControls();
      renderLive();
      await refreshSnapshots();
      try {
        var restored = await source.restore();
        if (!restored) {
          liveMessage('Choose the SaveData folder once to enable semi-live updates.', '');
          return;
        }
        applyLiveConnection(restored);
        if (!restored.connected) {
          liveMessage('Reconnect to grant read permission to the saved folder.', 'warn');
          return;
        }
        var loaded = await refreshFromFolder({ reason: 'restore', preserveSelection: false });
        startLiveWatch(loaded);
      } catch (err) {
        liveMessage('Could not restore the save folder: ' + err.message, 'warn');
      }
    }

    function bind() {
      if (dom.file) {
        dom.file.addEventListener('change', function (event) {
          var file = event.target.files && event.target.files[0];
          if (file) handleFile(file);
        });
      }

      if (dom.dropZone) {
        var highlight = function (event) {
          event.preventDefault();
          event.stopPropagation();
          dom.dropZone.classList.add('is-dragging');
        };
        var unhighlight = function (event) {
          event.preventDefault();
          event.stopPropagation();
          dom.dropZone.classList.remove('is-dragging');
        };

        dom.dropZone.addEventListener('dragenter', highlight);
        dom.dropZone.addEventListener('dragover', highlight);
        dom.dropZone.addEventListener('dragleave', unhighlight);
        dom.dropZone.addEventListener('drop', function (event) {
          unhighlight(event);
          var transfer = event.dataTransfer;
          var file = transfer && transfer.files && transfer.files[0];
          if (file) handleFile(file);
        });
        dom.dropZone.addEventListener('click', function () {
          if (dom.file) dom.file.click();
        });
        dom.dropZone.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault();
            if (dom.file) dom.file.click();
          }
        });
      }

      var changeSlotPage = function (delta) {
        var next = slotPageBounds(pageSlots().length, state.slotPage + delta);
        if (next.page === state.slotPage) return;
        state.slotPage = next.page;
        renderSlotList();
      };
      if (dom.slotPrev) {
        dom.slotPrev.addEventListener('click', function () { changeSlotPage(-1); });
      }
      if (dom.slotNext) {
        dom.slotNext.addEventListener('click', function () { changeSlotPage(1); });
      }
      if (dom.slotPopulated) {
        dom.slotPopulated.addEventListener('change', function () {
          state.populatedOnly = Boolean(dom.slotPopulated.checked);
          // Keep the selected save on screen when the list narrows; falling
          // back to page 0 covers a filter with no selected entry (no file).
          var at = state.selected ? pageSlots().indexOf(state.selected) : -1;
          state.slotPage = at === -1 ? 0 : Math.floor(at / SLOT_PAGE_SIZE);
          renderSlotList();
        });
      }

      if (dom.characterOpen) {
        dom.characterOpen.addEventListener('click', function () {
          openCharacterRail(true);
        });
      }
      if (dom.characterRailBack) {
        dom.characterRailBack.addEventListener('click', function () {
          closeCharacterRail(true);
        });
      }
      if (dom.characterRail) {
        dom.characterRail.addEventListener('keydown', function (event) {
          if (event.key === 'Escape') {
            if (event.preventDefault) event.preventDefault();
            closeCharacterRail(true);
          }
        });
      }
      // Roster selection opens the summary while focus deliberately stays on
      // the roster row, outside the rail. Escape must still dismiss the
      // drill-over from there, so the document fallback is intentional.
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('keydown', function (event) {
          if (state.railCharacterOpen && event.key === 'Escape') {
            if (event.preventDefault) event.preventDefault();
            closeCharacterRail(true);
          }
        });
      }

      bindPageIndex();

      if (state.constantsError) {
        setStatus(state.constantsError, 'warn');
      }
    }

    return {
      state: state,
      bind: bind,
      initLive: initLive,
      loadConstants: loadConstants,
      ingestBytes: ingestBytes,
      ingestFile: ingestFile,
      handleFile: handleFile,
      selectSlot: selectSlot,
      renderDetail: renderDetail
    };
  }

  /* ------------------------------------------------------------------ *
   * Exports and bootstrap
   * ------------------------------------------------------------------ */

  global.SaveCore = {
    BUILD: BUILD,
    tableUrl: tableUrl,
    SENTINELS: SENTINELS,
    SLOT_BLOB_MARKER: SLOT_BLOB_MARKER,
    cloneBuffer: cloneBuffer,
    publishOriginal: publishOriginal,
    sha256Hex: sha256Hex,
    findValueSpan: findValueSpan,
    getValueByPath: getValueByPath,
    slotPathFor: slotPathFor,
    buildOutput: buildOutput,
    proveRoundTrip: proveRoundTrip,
    diffModels: diffModels,
    changedRegion: changedRegion,
    bytesEqual: bytesEqual,
    readFileAsArrayBuffer: readFileAsArrayBuffer,
    sniffBytes: sniffBytes,
    hexDump: hexDump,
    indexOfBytes: indexOfBytes,
    inspectBytes: inspectBytes,
    decodeContainer: decodeContainer,
    decompressRaw: decompressRaw,
    decodeSavePayload: decodeSavePayload,
    parseContainer: parseContainer,
    listSlots: listSlots,
    entryFor: entryFor,
    parseSlot: parseSlot,
    buildViewModel: buildViewModel,
    makeResolver: makeResolver,
    displayName: displayName,
    hex2: hex2,
    hex4: hex4,
    decodeSkillGrid: decodeSkillGrid,
    decodeGifts: decodeGifts,
    raceLabel: raceLabel,
    battleRankFromParLev: battleRankFromParLev,
    hasCompletedScenario: hasCompletedScenario,
    encounterRankLabel: encounterRankLabel,
    matchFlagEntries: matchFlagEntries,
    buildSystemFile: buildSystemFile,
    buildShopRecord: buildShopRecord,
    summarizeShopRecords: summarizeShopRecords,
    buildScenarioFlags: buildScenarioFlags,
    scoreInitSets: scoreInitSets,
    predictInit: predictInit,
    buildInitSets: buildInitSets,
    scenarioName: scenarioName,
    elementFlags: elementFlags,
    buildAbilities: buildAbilities,
    buildAbilitySchools: buildAbilitySchools,
    buildElementCoverage: buildElementCoverage,
    buildCharacterDetail: buildCharacterDetail,
    buildCharacterRail: buildCharacterRail,
    buildMecProfile: buildMecProfile,
    buildMecProfileBlock: buildMecProfileBlock,
    buildMysticAbsorbs: buildMysticAbsorbs,
    buildMysticAbsorbBlock: buildMysticAbsorbBlock,
    buildMonsterForm: buildMonsterForm,
    buildMonsterFormBlock: buildMonsterFormBlock,
    MEC_BODY_TYPES: MEC_BODY_TYPES,
    MYSTIC_WEAPONS: MYSTIC_WEAPONS,
    MONSTER_RACES: MONSTER_RACES,
    STAT_FIELDS: STAT_FIELDS,
    rosterTargetFor: rosterTargetFor,
    formatNumber: formatNumber,
    formatPlayTime: formatPlayTime,
    buildSlotPicker: buildSlotPicker,
    buildFastSlots: buildFastSlots,
    slotsForFilter: slotsForFilter,
    slotPageBounds: slotPageBounds,
    buildDetail: buildDetail,
    collectIndexEntries: collectIndexEntries,
    activeIndexFor: activeIndexFor,
    buildPageIndexItems: buildPageIndexItems,
    snapshotTime: snapshotTime,
    buildSnapshotList: buildSnapshotList,
    sanitizeLiveSettings: sanitizeLiveSettings,
    buildByteInspector: buildByteInspector,
    buildFileInfo: buildFileInfo,
    collectText: collectText,
    h: h,
    createApp: createApp
  };

  if (typeof document !== 'undefined' && document.getElementById) {
    document.addEventListener('DOMContentLoaded', function () {
      var app = createApp({
        file: document.getElementById('save-file'),
        status: document.getElementById('status'),
        dropZone: document.getElementById('drop-zone'),
        dataContainer: document.getElementById('data-container'),
        fileInfo: document.getElementById('file-info'),
        byteInspector: document.getElementById('byte-inspector'),
        slotList: document.getElementById('slot-list'),
        slotFast: document.getElementById('slot-fast'),
        slotPopulated: document.getElementById('slot-populated'),
        slotPrev: document.getElementById('slot-prev'),
        slotNext: document.getElementById('slot-next'),
        slotPageStatus: document.getElementById('slot-page'),
        detail: document.getElementById('detail'),
        buildStamp: document.getElementById('build-stamp'),
        pageIndex: document.getElementById('page-index'),
        pageIndexView: document.getElementById('page-index-view'),
        characterOpen: document.getElementById('character-open'),
        characterRail: document.getElementById('character-rail'),
        characterRailBody: document.getElementById('character-rail-body'),
        characterRailBack: document.getElementById('character-rail-back'),
        pageIndexList: document.getElementById('page-index-list'),
        pageIndexHint: document.getElementById('page-index-hint'),
        pageIndexMobile: document.getElementById('page-index-mobile'),
        pageIndexMobileList: document.getElementById('page-index-mobile-list'),
        liveSave: document.getElementById('live-save'),
        liveState: document.getElementById('live-state'),
        livePick: document.getElementById('live-pick'),
        liveReconnect: document.getElementById('live-reconnect'),
        liveReload: document.getElementById('live-reload'),
        liveStatus: document.getElementById('live-status'),
        liveWatch: document.getElementById('live-watch'),
        liveAuto: document.getElementById('live-auto'),
        liveInterval: document.getElementById('live-interval'),
        liveSnapshots: document.getElementById('live-snapshots'),
        liveRetention: document.getElementById('live-retention'),
        snapshotBlock: document.getElementById('snapshot-block'),
        snapshotList: document.getElementById('snapshot-list'),
        snapshotEmpty: document.getElementById('snapshot-empty'),
        snapshotCount: document.getElementById('snapshot-count')
      });
      global.SaveViewerApp = app;
      function start() {
        app.bind();
        app.initLive();
      }
      app.loadConstants().then(start, start);
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
