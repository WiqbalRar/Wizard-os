/*
 * Lightning GNOME Launcher
 *
 * Copyright (C) 2026 Avimanyu Rimal
 *
 * Licensed under the GNU GPL v3 or later.
 * See LICENSE file for details.
 */

import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { ShortcutSettingWidget } from './shortcuts.js';

import {
  ExtensionPreferences,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class Preferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings('org.gnome.shell.extensions.lightning-launcher');

    const page = new Adw.PreferencesPage();
    const shortcutsGroup = new Adw.PreferencesGroup({
      title: 'Shortcut',
      description: 'Choose your launcher shortcut.',
    });

    const shortcutRow = new Adw.ActionRow({
      title: 'Open launcher',
      subtitle: 'Press this keybinding to open search',
    });
    shortcutRow.add_suffix(new ShortcutSettingWidget(settings, 'shortcut-key'));
    shortcutsGroup.add(shortcutRow);

    const aboutGroup = new Adw.PreferencesGroup({
      title: 'About',
    });
    const aboutRow = new Adw.ActionRow({
      title: 'Lightning GNOME Launcher',
      subtitle: 'JS-only GNOME launcher shortcut extension',
    });
    const linkButton = new Gtk.LinkButton({
      label: 'Project page',
      uri: 'https://gitlab.com/rimal.avimanyu/lightning-gnome-launcher-extension',
    });
    aboutRow.add_suffix(linkButton);
    aboutGroup.add(aboutRow);

    page.add(shortcutsGroup);
    page.add(aboutGroup);
    window.add(page);
  }
}

