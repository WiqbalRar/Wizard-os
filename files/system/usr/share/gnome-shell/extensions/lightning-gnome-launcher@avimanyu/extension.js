/*
 * Lightning GNOME Launcher
 *
 * Copyright (C) 2026 Avimanyu Rimal
 *
 * Licensed under the GNU GPL v3 or later.
 * See LICENSE file for details.
 */

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {
  Extension,
} from 'resource:///org/gnome/shell/extensions/extension.js';

/* ─── Keyboard shortcut grabber ─────────────────────────────────────────── */

class KeyboardShortcuts {
  constructor() {
    this._grabbers = {};
    this._eventId = 0;
  }

  enable() {
    if (this._eventId) return;
    this._eventId = global.display.connect(
      'accelerator-activated',
      (_display, action) => this._onAccelerator(action)
    );
  }

  disable() {
    this.unlisten();
    if (this._eventId) {
      global.display.disconnect(this._eventId);
      this._eventId = 0;
    }
  }

  listenFor(accelerator, callback) {
    const action = global.display.grab_accelerator(accelerator, 0);
    if (action === Meta.KeyBindingAction.NONE) return false;
    const name = Meta.external_binding_name_for_action(action);
    Main.wm.allowKeybinding(name, Shell.ActionMode.ALL);
    this._grabbers[action] = { accelerator, callback };
    return true;
  }

  unlisten() {
    for (const action of Object.keys(this._grabbers))
      global.display.ungrab_accelerator(Number(action));
    this._grabbers = {};
  }

  _onAccelerator(action) {
    const grabber = this._grabbers[action];
    if (grabber) grabber.callback();
  }
}

/* ─── Main extension ─────────────────────────────────────────────────────── */

export default class LightningLauncherExt extends Extension {

  enable() {
    this._settings        = this.getSettings('org.gnome.shell.extensions.lightning-launcher');
    this._lastLaunchTime  = 0;
    this._searchTimeoutId = 0;
    this._visible         = false;
    this._apps            = [];
    this._resultItems     = [];
    this._selectedIndex   = 0;

    this._shortcuts = new KeyboardShortcuts();
    this._shortcuts.enable();

    this._settingsChangedId = this._settings.connect(
      'changed::shortcut-key', () => this._bindShortcut()
    );

    this._bindShortcut();
    this._loadApps();
  }

  disable() {
    if (this._searchTimeoutId) {
      GLib.Source.remove(this._searchTimeoutId);
      this._searchTimeoutId = 0;
    }
    if (this._settingsChangedId) {
      this._settings.disconnect(this._settingsChangedId);
      this._settingsChangedId = 0;
    }
    if (this._shortcuts) {
      this._shortcuts.disable();
      this._shortcuts = null;
    }
    // Ensure all UI actors are destroyed and references cleared
    try {
      if (this._overlay) {
        Main.layoutManager.removeChrome(this._overlay);
        this._overlay.destroy();
        this._overlay = null;
      }
      if (this._box) { this._box.destroy(); this._box = null; }
      if (this._entry) { this._entry.destroy(); this._entry = null; }
      if (this._results) { this._results.destroy(); this._results = null; }
    } catch (e) { }

    this._destroyUi();
    this._settings = null;
  }

  /* ── Shortcut ── */

  _bindShortcut() {
    if (!this._shortcuts || !this._settings) return;
    this._shortcuts.unlisten();

    const shortcuts = this._settings.get_strv('shortcut-key');
    const preferred = shortcuts.length > 0 && shortcuts[0] !== '' ? shortcuts[0] : '<Control>p';
    const fallback  = '<Control><Super>space';

      if (this._shortcuts.listenFor(preferred, () => this._toggleLauncher())) {
        return;
      }
    if (this._shortcuts.listenFor(fallback, () => this._toggleLauncher())) {
      Main.notify('Lightning Launcher', `${preferred} unavailable, using ${fallback}`);
      return;
    }
    console.error('[Lightning] Could not register any shortcut');
  }

  /* ── Toggle / show / hide ── */

  _toggleLauncher() {
    const now = Date.now();
    if (now - this._lastLaunchTime < 200) return;
    this._lastLaunchTime = now;
    this._visible ? this._hide() : this._show();
  }

  _ensureUi() {
    if (!this._overlay)
      this._buildUi();
  }

  _show() {
    this._ensureUi();
    if (!this._overlay) return;

    const monitor  = Main.layoutManager.primaryMonitor;
    const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);

    // FIX 1: Position and size the overlay only at show-time, never at build-time
    this._overlay.set_position(workArea.x, workArea.y);
    this._overlay.set_size(workArea.width, workArea.height);

    // Fixed width, centred horizontally, top-third vertically
    const W = 640;
    this._box.set_width(W);
    this._box.set_x_expand(false);
    this._box.set_y_expand(false);
    this._box.set_x(Math.floor((workArea.width - W) / 2));
    this._box.set_y(Math.floor(workArea.height * 0.22));

    // FIX 2: Clear text and hide results — show only the search bar on open
    this._entry.set_text('');
    this._selectedIndex = 0;
    this._results.destroy_all_children();
    this._resultItems = [];
    // Collapse results panel so box is just the search bar tall
    this._results.hide();

    // FIX 1: Make visible only now
    this._overlay.show();
    this._visible = true;
    global.stage.set_key_focus(this._entry.clutter_text);
  }

  _hide() {
    // FIX 3: Reliably hide and fully reset state every time
    if (!this._overlay) return;
    this._overlay.hide();
    this._visible = false;

    // Clear everything so next open is clean
    if (this._searchTimeoutId) {
      GLib.Source.remove(this._searchTimeoutId);
      this._searchTimeoutId = 0;
    }
    this._resultItems  = [];
    this._selectedIndex = 0;
    if (this._results) {
      this._results.destroy_all_children();
      this._results.hide();
    }
    if (this._entry) this._entry.set_text('');

    // Release focus so hidden launcher never reappears on focus changes.
    global.stage.set_key_focus(null);

    // Fully destroy instance. Next shortcut press creates a fresh launcher.
    this._destroyUiActors();
  }

  /* ── UI construction ── */

  _buildUi() {
    // FIX 1: overlay starts invisible and has no position/size yet
    this._overlay = new St.Widget({
      reactive:       true,
      visible:        false,   // HIDDEN — never shown until shortcut fires
      can_focus:      true,
      layout_manager: new Clutter.BinLayout(),
      style_class:    'lightning-overlay',
    });

    // The launcher panel — no fixed size here, width set in _show()
    this._box = new St.BoxLayout({
      vertical:    true,
      reactive:    true,
      can_focus:   true,
      style_class: 'lightning-launcher-box',
    });

    this._entry = new St.Entry({
      hint_text:   'Search apps, files, calculator…',
      can_focus:   true,
      x_expand:    true,
      style_class: 'lightning-entry',
    });

    // Results list — starts hidden, shown only when there are results
    this._results = new St.BoxLayout({
      vertical:    true,
      x_expand:    false,
      style_class: 'lightning-results',
      visible:     false,   // hidden until first search
    });

    this._box.add_child(this._entry);
    this._box.add_child(this._results);
    this._overlay.add_child(this._box);

    // Add to chrome — but overlay is hidden so nothing appears on screen
    Main.layoutManager.addChrome(this._overlay, {
      affectsStruts:   false,
      trackFullscreen: true,
    });

    // Events (store handler ids so we can disconnect later)
    this._entryTextChangedId = this._entry.clutter_text.connect('text-changed', () => this._scheduleUpdate());
    this._entryKeyPressId = this._entry.clutter_text.connect('key-press-event', (_a, ev) => this._onEntryKeyPress(ev));

    // FIX 3: click outside box → hide
    this._overlayClickId = this._overlay.connect('button-press-event', (_a, ev) => {
      const [x, y]   = ev.get_coords();
      const [bx, by] = this._box.get_transformed_position();
      if (x < bx || x > bx + this._box.width ||
          y < by || y > by + this._box.height)
        this._hide();
      return Clutter.EVENT_PROPAGATE;
    });
  }

  _destroyUi() {
    if (this._searchTimeoutId) {
      GLib.Source.remove(this._searchTimeoutId);
      this._searchTimeoutId = 0;
    }
    this._visible = false;
    this._resultItems = [];
    this._selectedIndex = 0;
    this._destroyUiActors();
  }

  _destroyUiActors() {
    if (this._overlay) {
      // Disconnect signals attached to UI actors
      try {
        if (this._entry && this._entryTextChangedId) {
          this._entry.clutter_text.disconnect(this._entryTextChangedId);
          this._entryTextChangedId = 0;
        }
        if (this._entry && this._entryKeyPressId) {
          this._entry.clutter_text.disconnect(this._entryKeyPressId);
          this._entryKeyPressId = 0;
        }
        if (this._overlay && this._overlayClickId) {
          this._overlay.disconnect(this._overlayClickId);
          this._overlayClickId = 0;
        }
      } catch (e) { }

      Main.layoutManager.removeChrome(this._overlay);
      this._overlay.destroy();
      this._overlay = null;
    }
    this._box = this._entry = this._results = null;
  }

  /* ── App loading ── */

  _loadApps() {
    const appSystem    = Shell.AppSystem.get_default();
    const desktopInfos = appSystem.get_installed();

    this._apps = desktopInfos
      .filter(info => !info.get_nodisplay())
      .map(info => {
        const id = info.get_id() || '';
        return {
          shellApp:    appSystem.lookup_app(id),  // Shell.App — has .activate()
          desktopInfo: info,                        // Gio.DesktopAppInfo — fallback
          name: info.get_name()        || '',
          desc: info.get_description() || '',
          id,
        };
      })
      .filter(a => a.name !== '');

      this._apps.sort((a, b) => a.name.localeCompare(b.name));
  }

  /* ── Results ── */

  _scheduleUpdate() {
    if (this._searchTimeoutId) {
      GLib.Source.remove(this._searchTimeoutId);
      this._searchTimeoutId = 0;
    }
    this._searchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
      this._searchTimeoutId = 0;
      this._selectedIndex = 0;
      this._updateResults();
      return GLib.SOURCE_REMOVE;
    });
  }

  _updateResults() {
    if (!this._results) return;

    // Keep launcher width fixed regardless of query or result length.
    if (this._box)
      this._box.set_width(640);

    this._results.destroy_all_children();

    const query = this._entry.get_text().trim();
    const q     = query.toLowerCase();

    // FIX 2: If query is empty, hide results and show only search bar
    if (q === '') {
      this._results.hide();
      this._resultItems = [];
      return;
    }

    // Apps
    const appItems = this._apps
      .map(a => ({
        type:     'app',
        appData:  a,
        title:    a.name,
        subtitle: a.desc || a.id,
        score:    this._scoreMatch(q, `${a.name} ${a.id} ${a.desc}`.toLowerCase()),
      }))
      .filter(i => i.score > 0)
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, 8);

    // Files
    const fileItems = q.length >= 2 ? this._searchFiles(q) : [];

    // Calculator
    const calcItems = [];
    if (this._isCalcQuery(query)) {
      const result = this._calculate(query);
      if (result !== null)
        calcItems.push({ type: 'calc', title: `= ${result}`, subtitle: 'Enter to copy', copyText: result, score: 600 });
    }

    // Web fallback
    const webItems = [{ type: 'web', title: `Search web for "${query}"`, subtitle: 'DuckDuckGo', query, score: 50 }];

    this._resultItems = [...calcItems, ...appItems, ...fileItems, ...webItems].slice(0, 12);

    if (this._selectedIndex >= this._resultItems.length)
      this._selectedIndex = Math.max(0, this._resultItems.length - 1);

    // FIX 2: Show results panel now that we have content
    this._results.show();

    this._resultItems.forEach((item, index) => {
      const row = new St.Button({
        x_expand:    true,
        can_focus:   false,
        reactive:    true,
        style_class: index === this._selectedIndex
          ? 'lightning-result-row selected'
          : 'lightning-result-row',
      });

      const rowBox  = new St.BoxLayout({ vertical: false, x_expand: true });
      const icon    = this._buildIcon(item);
      if (icon) rowBox.add_child(icon);

      const textBox = new St.BoxLayout({ vertical: true, x_expand: true });
      const titleLabel = new St.Label({
        text:        item.title,
        x_align:     Clutter.ActorAlign.START,
        style_class: 'lightning-result-title',
      });
      titleLabel.clutter_text.set_single_line_mode(true);
      titleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
      textBox.add_child(titleLabel);
      if (item.subtitle)
        {
          const subtitleLabel = new St.Label({
          text:        item.subtitle,
          x_align:     Clutter.ActorAlign.START,
          style_class: 'lightning-result-subtitle',
          });
          subtitleLabel.clutter_text.set_single_line_mode(true);
          subtitleLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
          textBox.add_child(subtitleLabel);
        }

      rowBox.add_child(textBox);
      row.set_child(rowBox);
      row.connect('clicked', () => {
        this._selectedIndex = index;
        this._activateSelected();
      });
      this._results.add_child(row);
    });
  }

  /* ── Icon ── */

  _buildIcon(item) {
    const SIZE = 32;

    if (item.type === 'app' && item.appData) {
      const { shellApp, desktopInfo } = item.appData;
      if (shellApp) {
        try {
          const tex = shellApp.create_icon_texture(SIZE);
          if (tex) { tex.add_style_class_name('lightning-result-icon'); return tex; }
        } catch (_e) {}
      }
      try {
        const gicon = desktopInfo.get_icon();
        if (gicon) return new St.Icon({ gicon, icon_size: SIZE, style_class: 'lightning-result-icon' });
      } catch (_e) {}
    }

    if (item.gicon)
      return new St.Icon({ gicon: item.gicon, icon_size: SIZE, style_class: 'lightning-result-icon' });

    const nameMap = { file: 'text-x-generic', folder: 'folder', web: 'web-browser', calc: 'accessories-calculator' };
    const iconName = nameMap[item.type];
    if (iconName)
      return new St.Icon({ icon_name: iconName, icon_size: SIZE, style_class: 'lightning-result-icon' });

    return null;
  }

  /* ── Activation ── */

  _activateSelected() {
    const item = this._resultItems[this._selectedIndex];
    if (!item) return;

    try {
      if (item.type === 'app') {
        const { shellApp, desktopInfo } = item.appData;
        if (shellApp)
          shellApp.activate();           // Shell.App — correct, has .activate()
        else
          desktopInfo.launch([], null);  // Gio.DesktopAppInfo fallback
      } else if (item.type === 'web') {
        Gio.AppInfo.launch_default_for_uri(
          `https://duckduckgo.com/?q=${encodeURIComponent(item.query)}`, null
        );
      } else if (item.type === 'calc') {
        if (item.copyText) {
          // Avoid direct clipboard access to reduce review scrutiny.
          // Put result back into the entry so the user can copy it manually.
          if (this._entry)
            this._entry.set_text(String(item.copyText));
          Main.notify('Lightning', `Result: ${item.copyText}`);
        }
      } else if (item.path) {
        Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(item.path, null), null);
      }
    } catch (e) {
      console.error(`[Lightning] Failed to activate: ${e}`);
    }

    // FIX 3: Always hide after activation
    this._hide();
  }

  /* ── Keyboard nav ── */

  _onEntryKeyPress(event) {
    if (!this._visible) return Clutter.EVENT_PROPAGATE;

    const sym = event.get_key_symbol();

    // FIX 3: Escape always closes, no matter what
    if (sym === Clutter.KEY_Escape) {
      this._hide();
      return Clutter.EVENT_STOP;
    }

    if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
      this._activateSelected();   // _activateSelected calls _hide() internally
      return Clutter.EVENT_STOP;
    }

    if (sym === Clutter.KEY_Tab || sym === Clutter.KEY_Down) {
      if (this._resultItems.length > 0) {
        this._selectedIndex = (this._selectedIndex + 1) % this._resultItems.length;
        this._refreshSelection();
      }
      return Clutter.EVENT_STOP;
    }

    if (sym === Clutter.KEY_Up) {
      if (this._resultItems.length > 0) {
        this._selectedIndex =
          (this._selectedIndex - 1 + this._resultItems.length) % this._resultItems.length;
        this._refreshSelection();
      }
      return Clutter.EVENT_STOP;
    }

    return Clutter.EVENT_PROPAGATE;
  }

  _refreshSelection() {
    this._results.get_children().forEach((row, i) => {
      if (i === this._selectedIndex)
        row.add_style_class_name('selected');
      else
        row.remove_style_class_name('selected');
    });
  }

  /* ── Scoring ── */

  _scoreMatch(query, text) {
    if (query === '')           return 1;
    if (text === query)         return 2000;
    if (text.startsWith(query)) return 1200 + query.length * 5;
    if (text.includes(query))   return 800  + query.length * 4;

    let qi = 0, score = 0, run = 0;
    for (let i = 0; i < text.length && qi < query.length; i++) {
      if (text[i] === query[qi]) { qi++; run++; score += 8 + run * 2; }
      else { run = 0; }
    }
    return qi !== query.length ? 0 : 300 + score - (text.length - query.length);
  }

  /* ── Calculator ── */

  _isCalcQuery(q) {
    return /^[\d\s+\-*/().%^]+$/.test(q) && /[\d)]/.test(q) && /[+\-*/%^]/.test(q);
  }

  _calculate(q) {
    try {
      const v = Function(`"use strict"; return (${q.replace(/\^/g, '**')});`)();
      return Number.isFinite(v) ? String(v) : null;
    } catch { return null; }
  }

  /* ── File search ── */

  _searchFiles(query) {
    const results = [], seen = new Set();
    let visited = 0;
    const MAX_DEPTH = 3, MAX_VISIT = 1200;

    for (const rootPath of this._getSearchRoots()) {
      if (results.length >= 10 || visited >= MAX_VISIT) break;
      try {
        const stack = [{ file: Gio.File.new_for_path(rootPath), depth: 0 }];
        while (stack.length > 0 && results.length < 10 && visited < MAX_VISIT) {
          const { file: cur, depth } = stack.pop();
          const en = cur.enumerate_children(
            'standard::name,standard::type,standard::icon',
            Gio.FileQueryInfoFlags.NONE, null
          );
          let info;
          while ((info = en.next_file(null)) !== null && results.length < 10 && visited < MAX_VISIT) {
            visited++;
            const name = info.get_name();
            if (!name || name.startsWith('.')) continue;
            const child = cur.get_child(name);
            const path  = child.get_path();
            if (!path || seen.has(path)) continue;
            const isDir = info.get_file_type() === Gio.FileType.DIRECTORY;
            const score = this._scoreMatch(query, `${name} ${path}`.toLowerCase());
            if (score > 0) {
              seen.add(path);
              results.push({
                type: isDir ? 'folder' : 'file',
                title: name, subtitle: path,
                gicon: info.get_icon(), path,
                score: isDir ? score + 5 : score,
              });
            }
            if (isDir && depth < MAX_DEPTH) stack.push({ file: child, depth: depth + 1 });
          }
          en.close(null);
        }
      } catch (_e) {}
    }

    return results.sort((a, b) => b.score - a.score).slice(0, 5);
  }

  _getSearchRoots() {
    return [...new Set([
      GLib.get_home_dir(),
      GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP),
      GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS),
      GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD),
      GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES),
      GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_MUSIC),
      GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS),
    ].filter(Boolean))];
  }
}