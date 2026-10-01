package com.pelednoam.safebikes;

import java.io.File;

/**
 * The names the app saves files under, kept apart from Android so they can be
 * compiled and tried on their own.
 */
final class SaveNames {
    private SaveNames() {}

    /**
     * A plain file name: letters, digits, dots, dashes and underscores, and not
     * only dots. "." and ".." are made of allowed characters and name the folder
     * itself, or the one above it.
     */
    static boolean isPlain(String name) {
        return name != null && name.matches("[A-Za-z0-9._-]{1,120}") && !name.matches("\\.+");
    }

    /**
     * A file in `dir` called `name`, or, if there is one already, "name (1).ext",
     * "name (2).ext" and so on: what Downloads does with a repeated name on
     * Android 10 and later, so the older phones do the same and a second GPX of
     * the same ride doesn't replace the first.
     */
    static File uniqueIn(File dir, String name) {
        File file = new File(dir, name);
        if (!file.exists()) {
            return file;
        }
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int n = 1; n < 10_000; n++) {
            File next = new File(dir, stem + " (" + n + ")" + ext);
            if (!next.exists()) {
                return next;
            }
        }
        return file;
    }
}
