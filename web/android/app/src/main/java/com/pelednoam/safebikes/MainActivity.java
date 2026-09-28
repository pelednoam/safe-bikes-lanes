package com.pelednoam.safebikes;

import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.URLUtil;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Before super.onCreate: the bridge is built there, from this list.
        registerPlugin(AppShellPlugin.class);
        super.onCreate(savedInstanceState);
        // No permission is asked for here any more. Location used to be requested
        // the moment the app opened, before anyone had planned anything, with
        // nothing to say why. It is asked when it is needed instead: the WebView
        // asks the first time "Your location" is used, and a ride asks through
        // AppShellPlugin before it starts the watcher.

        // A WebView silently drops downloads, so tapping "install" on the in-app
        // update banner did nothing at all. The first fix handed the URL to
        // ACTION_VIEW — "let some other app open this" — which is not a download
        // request: whichever app claimed the link decided what to do with it, and
        // the file never reliably arrived anywhere the rider could find it.
        //
        // The update banner now calls AppShellPlugin.downloadUpdate directly, which
        // names the file for its version. This listener stays for anything else
        // the WebView is asked to download.
        //
        // It used to send everything through the updater: a CSV came out as
        // family-bike-router.apk with the APK type, and a GPX or a backup (a blob:
        // URL, which DownloadManager refuses) fell through to ACTION_VIEW on a
        // blob: URL, which no app can open, and crashed the app. The page now
        // saves its own files through AppShellPlugin.saveFile; a blob: or data:
        // URL that still arrives here is dropped rather than taken down with it.
        getBridge()
                .getWebView()
                .setDownloadListener(
                        (url, userAgent, contentDisposition, mimetype, contentLength) -> {
                            if (url == null
                                    || !(url.startsWith("https://") || url.startsWith("http://"))) {
                                return;
                            }
                            String name = URLUtil.guessFileName(url, contentDisposition, mimetype);
                            if (name.endsWith(".apk") || UpdateDownloader.APK_MIME.equals(mimetype)) {
                                // an app to install comes over https or not at all
                                if (url.startsWith("https://")) {
                                    downloadUpdate(url, name);
                                }
                            } else {
                                downloadFile(url, name, mimetype);
                            }
                        });
    }

    /** Any other file, into Downloads, as what it is. */
    private void downloadFile(String url, String name, String mimetype) {
        try {
            DownloadManager manager =
                    (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) {
                throw new IllegalStateException("no DownloadManager on this device");
            }
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle(name);
            if (mimetype != null && !mimetype.isEmpty()) {
                request.setMimeType(mimetype);
            }
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            } else {
                request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name);
            }
            manager.enqueue(request);
        } catch (RuntimeException e) {
            openElsewhere(url);
        }
    }

    /** Download through the system, into Downloads, with a notification.
     *
     * The fallback matters: DownloadManager is a system service and can be disabled
     * or unavailable on a given device, and a rider who taps "install" and gets
     * nothing has no way to tell whether the app failed or the update does not
     * exist. Handing the URL to the browser at least puts the file within reach.
     */
    private void downloadUpdate(String url, String fileName) {
        try {
            UpdateDownloader.enqueue(this, url, fileName);
        } catch (RuntimeException e) {
            openElsewhere(url);
        }
    }

    /** The last resort: let another app have the link. Nothing to open it with
     * is the end of the attempt, not of the app. */
    private void openElsewhere(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            // nothing on this phone takes the link; the rider saw nothing happen,
            // which is what would have happened anyway, minus the crash
        }
    }
}
