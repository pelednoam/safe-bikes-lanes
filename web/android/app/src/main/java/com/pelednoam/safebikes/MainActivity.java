package com.pelednoam.safebikes;

import android.app.DownloadManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;

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
        // DownloadManager is the API for this. It fetches through the system,
        // follows GitHub's redirect to the release asset, shows progress in the
        // notification shade, and writes the file to the public Downloads folder
        // under a name worth reading — which is where somebody told "it is
        // downloading" will go looking for it.
        getBridge()
                .getWebView()
                .setDownloadListener(
                        (url, userAgent, contentDisposition, mimetype, contentLength) ->
                                downloadUpdate(url));
    }

    /** Download the update through the system, into Downloads, with a notification.
     *
     * The fallback matters: DownloadManager is a system service and can be disabled
     * or unavailable on a given device, and a rider who taps "install" and gets
     * nothing has no way to tell whether the app failed or the update does not
     * exist. Handing the URL to the browser at least puts the file within reach.
     */
    private void downloadUpdate(String url) {
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle("Safe Bike Lanes update");
            request.setDescription("Tap when finished to install");
            request.setMimeType("application/vnd.android.package-archive");
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(
                    Environment.DIRECTORY_DOWNLOADS, "family-bike-router.apk");
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (manager == null) {
                throw new IllegalStateException("no DownloadManager on this device");
            }
            manager.enqueue(request);
        } catch (RuntimeException e) {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        }
    }
}
