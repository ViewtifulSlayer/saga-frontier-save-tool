/*
 * Browser adapter for the SaGa Frontier Remastered save tool.
 *
 * This file is loaded before app.js and exposes window.SaveSource. The reader
 * itself never calls the File System Access API directly, so a different
 * platform (Tauri or Electron) can provide the same small contract later.
 *
 * The folder is opened in read mode. Nothing here writes to the game folder:
 * the only persistent copies are optional snapshots stored in IndexedDB, and
 * exporting one is an ordinary browser download.
 */
(function (global) {
  'use strict';

  var DB_NAME = 'sfr-save-viewer';
  var DB_VERSION = 1;
  var HANDLE_STORE = 'handles';
  var SNAPSHOT_STORE = 'snapshots';
  var HANDLE_KEY = 'save-directory';
  var SAVE_NAME = 'SaveData.bin';
  var PICKER_ID = 'sfr-save-data';
  var DEFAULT_INTERVAL = 2000;

  function noop() {}

  function isFunction(value) {
    return typeof value === 'function';
  }

  function cloneArrayBuffer(buffer) {
    if (buffer instanceof ArrayBuffer) return buffer.slice(0);
    if (buffer && buffer.buffer instanceof ArrayBuffer) {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
    throw new Error('Snapshot data is not an ArrayBuffer.');
  }

  function timestampName(iso) {
    var date = new Date(iso);
    function part(value) {
      return String(value).padStart(2, '0');
    }
    return 'SaveData-' +
      date.getUTCFullYear() + part(date.getUTCMonth() + 1) + part(date.getUTCDate()) + '-' +
      part(date.getUTCHours()) + part(date.getUTCMinutes()) + part(date.getUTCSeconds()) +
      '.bin';
  }

  function publicSnapshot(record) {
    if (!record) return null;
    return {
      id: record.id,
      fileName: record.fileName,
      createdAt: record.createdAt,
      bytes: record.bytes,
      sha256: record.sha256,
      sourceName: record.sourceName
    };
  }

  function openDatabase(factory) {
    if (!factory || !isFunction(factory.open)) {
      return Promise.reject(new Error('IndexedDB is not available.'));
    }
    return new Promise(function (resolve, reject) {
      var request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(HANDLE_STORE)) {
          db.createObjectStore(HANDLE_STORE);
        }
        if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
          db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () {
        reject(request.error || new Error('Could not open IndexedDB.'));
      };
    });
  }

  // The adapter takes this small store shape in tests. The real one stores the
  // directory handle and snapshot records in IndexedDB; both survive a reload.
  function createIdbStore(factory) {
    var opened = null;

    function db() {
      if (!opened) opened = openDatabase(factory);
      return opened;
    }

    function request(name, mode, action) {
      return db().then(function (database) {
        return new Promise(function (resolve, reject) {
          var transaction;
          var store;
          var result;
          try {
            transaction = database.transaction(name, mode);
            store = transaction.objectStore(name);
            result = action(store);
          } catch (err) {
            reject(err);
            return;
          }
          if (!result) {
            resolve(undefined);
            return;
          }
          result.onsuccess = function () { resolve(result.result); };
          result.onerror = function () {
            reject(result.error || new Error('IndexedDB request failed.'));
          };
        });
      });
    }

    return {
      getHandle: function () {
        return request(HANDLE_STORE, 'readonly', function (store) {
          return store.get(HANDLE_KEY);
        });
      },
      putHandle: function (handle) {
        return request(HANDLE_STORE, 'readwrite', function (store) {
          return store.put(handle, HANDLE_KEY);
        });
      },
      listSnapshots: function () {
        return request(SNAPSHOT_STORE, 'readonly', function (store) {
          return store.getAll();
        });
      },
      putSnapshot: function (record) {
        return request(SNAPSHOT_STORE, 'readwrite', function (store) {
          return store.put(record);
        });
      },
      deleteSnapshot: function (id) {
        return request(SNAPSHOT_STORE, 'readwrite', function (store) {
          return store.delete(id);
        });
      }
    };
  }

  function describe(handle, permission) {
    return {
      name: handle && handle.name ? handle.name : '',
      permission: permission,
      connected: permission === 'granted'
    };
  }

  function createBrowserSource(options) {
    options = options || {};
    var root = options.global || global;
    var picker = options.showDirectoryPicker || root.showDirectoryPicker;
    var idb = options.indexedDB || root.indexedDB;
    var store = options.store || (idb ? createIdbStore(idb) : null);
    var FileObserver = options.FileSystemObserver || root.FileSystemObserver;
    var timers = options.timers || {
      setInterval: function (fn, ms) { return root.setInterval(fn, ms); },
      clearInterval: function (id) { return root.clearInterval(id); },
      setTimeout: function (fn, ms) { return root.setTimeout(fn, ms); },
      clearTimeout: function (id) { return root.clearTimeout(id); }
    };
    var now = options.now || function () { return Date.now(); };
    var handle = null;
    var supported = isFunction(picker);
    var hasStore = Boolean(store);

    function remember(handleToStore) {
      if (!hasStore) return Promise.resolve();
      return store.putHandle(handleToStore).catch(function () {
        // A private window can reject persistence. Watching still works for
        // this page; only the reconnect-after-reload path is unavailable.
        hasStore = false;
      });
    }

    function permissionFor(candidate) {
      if (!candidate || !isFunction(candidate.queryPermission)) {
        return Promise.resolve('granted');
      }
      return candidate.queryPermission({ mode: 'read' }).catch(function () {
        return 'denied';
      });
    }

    function requireHandle() {
      if (!handle) throw new Error('Choose a save folder first.');
      return handle;
    }

    function fileStat() {
      return requireHandle().getFileHandle(SAVE_NAME).then(function (fileHandle) {
        return fileHandle.getFile();
      }).then(function (file) {
        return { size: file.size, lastModified: file.lastModified, file: file };
      });
    }

    async function read() {
      var result = await fileStat();
      var buffer = await result.file.arrayBuffer();
      return {
        buffer: buffer,
        name: result.file.name || SAVE_NAME,
        size: result.size,
        lastModified: result.lastModified
      };
    }

    function watch(callback, watchOptions) {
      watchOptions = watchOptions || {};
      var sourceHandle = requireHandle();
      var interval = Math.max(1000, Number(watchOptions.interval) || DEFAULT_INTERVAL);
      var onError = isFunction(watchOptions.onError) ? watchOptions.onError : noop;
      var baseline = null;
      var candidate = null;
      var busy = false;
      var stopped = false;
      var timer = null;
      var observer = null;

      if (watchOptions.baseline &&
          typeof watchOptions.baseline.size === 'number' &&
          typeof watchOptions.baseline.lastModified === 'number') {
        baseline = watchOptions.baseline.size + ':' + watchOptions.baseline.lastModified;
      }

      function notify(info) {
        baseline = info.size + ':' + info.lastModified;
        candidate = null;
        try {
          var outcome = callback({
            name: info.file.name || SAVE_NAME,
            size: info.size,
            lastModified: info.lastModified
          });
          if (outcome && isFunction(outcome.catch)) outcome.catch(onError);
        } catch (callbackError) {
          onError(callbackError);
        }
      }

      async function check() {
        if (stopped || busy) return;
        busy = true;
        try {
          var info;
          try {
            info = await fileStat();
          } catch (firstError) {
            // A file can be briefly unavailable while the game rotates it.
            try {
              info = await fileStat();
            } catch (secondError) {
              onError(secondError);
              return;
            }
          }
          var signature = info.size + ':' + info.lastModified;
          if (baseline === null) {
            // No successful load has established a baseline yet. Treat the
            // first stable file as a change so a folder that was empty at
            // pick time still loads once the game writes its first save.
            if (candidate === signature) notify(info);
            else candidate = signature;
            return;
          }
          if (signature === baseline) {
            candidate = null;
            return;
          }
          if (candidate === signature) {
            notify(info);
            return;
          }
          candidate = signature;
        } finally {
          busy = false;
        }
      }

      timer = timers.setInterval(check, interval);
      if (isFunction(FileObserver)) {
        try {
          observer = new FileObserver(function () { check(); });
          var observation = observer.observe(sourceHandle, { recursive: false });
          if (observation && isFunction(observation.catch)) {
            observation.catch(function () { observer = null; });
          }
        } catch (err) {
          observer = null;
        }
      }

      return function unsubscribe() {
        stopped = true;
        candidate = null;
        if (timer !== null) {
          timers.clearInterval(timer);
          timer = null;
        }
        if (observer && isFunction(observer.disconnect)) {
          try { observer.disconnect(); } catch (err) { /* already gone */ }
        }
        observer = null;
      };
    }

    async function prune(retention) {
      if (!hasStore) return;
      var limit = Math.max(1, Math.min(50, Number(retention) || 10));
      var records = await store.listSnapshots();
      records.sort(function (left, right) {
        return String(left.createdAt).localeCompare(String(right.createdAt));
      });
      var remove = Math.max(0, records.length - limit);
      for (var index = 0; index < remove; index++) {
        await store.deleteSnapshot(records[index].id);
      }
    }

    async function saveSnapshot(payload, retention) {
      if (!hasStore) throw new Error('Snapshot storage is not available in this browser.');
      if (!payload || !payload.buffer) throw new Error('No snapshot bytes supplied.');
      var records = await store.listSnapshots();
      if (payload.sha256) {
        var duplicate = records.filter(function (record) {
          return record.sha256 === payload.sha256;
        })[0];
        if (duplicate) {
          await prune(retention);
          return { record: publicSnapshot(duplicate), duplicate: true };
        }
      }
      var createdAt = new Date(now()).toISOString();
      var record = {
        id: createdAt + '-' + String(payload.sha256 || now()).slice(0, 8),
        fileName: timestampName(createdAt),
        createdAt: createdAt,
        bytes: Number(payload.bytes) || payload.buffer.byteLength,
        sha256: payload.sha256 || null,
        sourceName: payload.name || SAVE_NAME,
        buffer: cloneArrayBuffer(payload.buffer)
      };
      await store.putSnapshot(record);
      await prune(retention);
      return { record: publicSnapshot(record), duplicate: false };
    }

    return {
      kind: 'directory',
      supported: supported,
      capabilities: {
        directory: supported,
        watch: supported,
        persist: hasStore,
        snapshots: hasStore,
        write: false
      },

      pick: async function () {
        if (!supported) throw new Error('Folder access is not supported in this browser.');
        var picked = await picker.call(root, { id: PICKER_ID, mode: 'read' });
        if (!picked) throw new Error('No folder selected.');
        handle = picked;
        await remember(picked);
        return describe(picked, await permissionFor(picked));
      },

      restore: async function () {
        if (!hasStore) return null;
        var saved = await store.getHandle();
        if (!saved) return null;
        handle = saved;
        return describe(saved, await permissionFor(saved));
      },

      reconnect: async function () {
        var candidate = handle;
        if (!candidate && hasStore) candidate = await store.getHandle();
        if (!candidate) return null;
        handle = candidate;
        var permission = isFunction(candidate.requestPermission)
          ? await candidate.requestPermission({ mode: 'read' })
          : await permissionFor(candidate);
        if (permission === 'granted') await remember(candidate);
        return describe(candidate, permission);
      },

      read: read,
      watch: watch,

      saveSnapshot: saveSnapshot,
      pruneSnapshots: prune,
      listSnapshots: async function () {
        if (!hasStore) return [];
        var records = await store.listSnapshots();
        records.sort(function (left, right) {
          return String(right.createdAt).localeCompare(String(left.createdAt));
        });
        return records.map(publicSnapshot);
      },
      getSnapshot: async function (id) {
        if (!hasStore) return null;
        var records = await store.listSnapshots();
        return records.filter(function (record) { return record.id === id; })[0] || null;
      }
    };
  }

  var api = {
    SAVE_NAME: SAVE_NAME,
    createBrowserSource: createBrowserSource,
    createIdbStore: createIdbStore,
    publicSnapshot: publicSnapshot,
    timestampName: timestampName
  };

  if (global) global.SaveSource = createBrowserSource({ global: global });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
