package com.pelednoam.safebikes;

import android.app.DownloadManager;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;

import java.util.ArrayList;
import java.util.List;

/**
 * Downloads an app update through the system's DownloadManager.
 *
 * <p>DownloadManager fetches through the system, follows GitHub's redirect to the
 * release asset, shows progress in the notification shade, and tapping the
 * finished download opens the installer.
 *
 * <p>Three things it did not do before:
 *
 * <ul>
 *   <li>Name the file for its version. Every update was "family-bike-router.apk";
 *       the second one became "family-bike-router-1.apk", and the one a person
 *       found first in Downloads was the old one, which Android refuses to
 *       install over the newer app.
 *   <li>Clear up. Earlier update downloads are removed — the entry and the file —
 *       so Downloads holds one update, the newest. DownloadManager lists only this
 *       app's own downloads, so nothing else is touched.
 *   <li>Work on Android 7-9 without a permission it never had. A public Downloads
 *       destination needs WRITE_EXTERNAL_STORAGE below Android 10, so there the
 *       request failed and fell back to the browser. Those versions now download
 *       into the app's own external files; the notification and the system
 *       Downloads list both still reach it.
 * </ul>
 */
final class UpdateDownloader {
    static final String DEFAULT_NAME = "family-bike-router.apk";
    static final String TITLE = "Safe Bike Lanes update";
    static final String APK_MIME = "application/vnd.android.package-archive";

    private UpdateDownloader() {}

    /** A file name safe to hand DownloadManager: no paths, and ending in .apk. */
    static String safeName(String fileName) {
        if (fileName == null || !fileName.matches("[A-Za-z0-9._-]{1,80}\\.apk")) {
            return DEFAULT_NAME;
        }
        return fileName;
    }

    /**
     * Start the download, clearing earlier ones. Returns "started", or "running"
     * when this same update is already downloading (a second tap on "install").
     */
    static String enqueue(Context context, String url, String fileName) {
        DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) {
            throw new IllegalStateException("no DownloadManager on this device");
        }
        String name = safeName(fileName);
        String title = TITLE + " (" + name + ")";
        if (clearEarlier(manager, title)) {
            return "running";
        }
        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
        request.setTitle(title);
        request.setDescription("Tap when finished to install");
        request.setMimeType(APK_MIME);
        request.setNotificationVisibility(
                DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
        } else {
            request.setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, name);
        }
        manager.enqueue(request);
        return "started";
    }

    /**
     * Remove this app's earlier update downloads. Returns true, removing nothing
     * more, if `title` (this very update) is already in progress.
     */
    private static boolean clearEarlier(DownloadManager manager, String title) {
        List<Long> stale = new ArrayList<>();
        try (Cursor cursor = manager.query(new DownloadManager.Query())) {
            if (cursor == null) {
                return false;
            }
            int idCol = cursor.getColumnIndex(DownloadManager.COLUMN_ID);
            int titleCol = cursor.getColumnIndex(DownloadManager.COLUMN_TITLE);
            int statusCol = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS);
            int typeCol = cursor.getColumnIndex(DownloadManager.COLUMN_MEDIA_TYPE);
            if (idCol < 0 || titleCol < 0 || statusCol < 0) {
                return false;
            }
            while (cursor.moveToNext()) {
                String rowTitle = cursor.getString(titleCol);
                String rowType = typeCol < 0 ? null : cursor.getString(typeCol);
                boolean ours =
                        (rowTitle != null && rowTitle.startsWith(TITLE)) || APK_MIME.equals(rowType);
                if (!ours) {
                    continue;
                }
                int status = cursor.getInt(statusCol);
                boolean active =
                        status == DownloadManager.STATUS_PENDING
                                || status == DownloadManager.STATUS_RUNNING
                                || status == DownloadManager.STATUS_PAUSED;
                if (active && title.equals(rowTitle)) {
                    return true;
                }
                stale.add(cursor.getLong(idCol));
            }
        } catch (RuntimeException e) {
            // Clearing up is a nicety; never let it stop the update itself.
            return false;
        }
        for (long id : stale) {
            try {
                manager.remove(id);
            } catch (RuntimeException ignored) {
                // one entry that will not go is no reason to skip the rest
            }
        }
        return false;
    }
}
