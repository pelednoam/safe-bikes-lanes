package com.pelednoam.safebikes;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.view.WindowManager;

import androidx.core.content.ContextCompat;
import androidx.core.location.LocationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/**
 * What the web app needs from Android that no installed plugin gives it.
 *
 * <p>Location, in enough detail to say the right thing. The background-location
 * plugin reports "NOT_AUTHORIZED" both when permission was refused and when the
 * phone's location switch is simply off, and it cannot tell precise location
 * from Android 12's "Approximate" — which is a circle kilometres wide, useless
 * for turn-by-turn. So the app asked everyone to set "Allow all the time" and
 * opened app settings, which fixes neither the switch nor the precision.
 *
 * <p>And the order of asking. That plugin requests location itself and then goes
 * on to start its foreground service in the same call, before the answer is in;
 * on Android 14+ that start is refused without the permission, the refusal is
 * caught and logged, and nothing retries it — so a first ride navigated only
 * while the screen stayed on. Asking here first, and only then adding the
 * watcher, means the service starts with the permission already held.
 *
 * <p>Also the notification permission (Android 13+), without which the "navigation
 * is running" notice is hidden, keeping the screen on for a ride only, and the
 * update download.
 */
@CapacitorPlugin(
        name = "AppShell",
        permissions = {
            @Permission(
                    alias = AppShellPlugin.LOCATION,
                    strings = {
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                    }),
            @Permission(
                    alias = AppShellPlugin.NOTIFICATIONS,
                    strings = {Manifest.permission.POST_NOTIFICATIONS})
        })
public class AppShellPlugin extends Plugin {
    static final String LOCATION = "location";
    static final String NOTIFICATIONS = "notifications";

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission)
                == PackageManager.PERMISSION_GRANTED;
    }

    /** "granted" below Android 13, where there is nothing to ask for. */
    private String notificationState() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return PermissionState.GRANTED.toString();
        }
        PermissionState state = getPermissionState(NOTIFICATIONS);
        return state == null ? PermissionState.PROMPT.toString() : state.toString();
    }

    private JSObject locationSnapshot() {
        LocationManager manager =
                (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        JSObject result = new JSObject();
        result.put("precise", granted(Manifest.permission.ACCESS_FINE_LOCATION));
        result.put("approximate", granted(Manifest.permission.ACCESS_COARSE_LOCATION));
        result.put("enabled", manager != null && LocationManagerCompat.isLocationEnabled(manager));
        result.put("notifications", notificationState());
        return result;
    }

    /** Where location stands, without asking anything. */
    @PluginMethod
    public void locationStatus(PluginCall call) {
        call.resolve(locationSnapshot());
    }

    /**
     * Ask for precise location if it is not already held. With only approximate
     * granted, Android 12+ answers this with its "change to precise" dialog.
     */
    @PluginMethod
    public void requestLocation(PluginCall call) {
        if (granted(Manifest.permission.ACCESS_FINE_LOCATION)) {
            call.resolve(locationSnapshot());
            return;
        }
        requestPermissionForAlias(LOCATION, call, "afterLocationRequest");
    }

    @PermissionCallback
    private void afterLocationRequest(PluginCall call) {
        call.resolve(locationSnapshot());
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || granted(Manifest.permission.POST_NOTIFICATIONS)) {
            JSObject result = new JSObject();
            result.put("notifications", PermissionState.GRANTED.toString());
            call.resolve(result);
            return;
        }
        requestPermissionForAlias(NOTIFICATIONS, call, "afterNotificationRequest");
    }

    @PermissionCallback
    private void afterNotificationRequest(PluginCall call) {
        JSObject result = new JSObject();
        result.put("notifications", notificationState());
        call.resolve(result);
    }

    /** The phone's own location switch, for when it is off. */
    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        openSettings(call, new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
    }

    /** This app's page in Settings, for a refused or approximate permission. */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        openSettings(call, intent);
    }

    private void openSettings(PluginCall call, Intent intent) {
        try {
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("no settings screen for this on this phone");
        }
    }

    /**
     * Keep the screen on for a ride, and only for a ride.
     *
     * <p>This used to be FLAG_KEEP_SCREEN_ON set once for the whole activity, so the
     * phone never slept while the app was open — planning at a desk included. The
     * web code's Wake Lock request cannot cover the ride on its own: whether an
     * Android WebView honours it depends on the WebView.
     */
    @PluginMethod
    public void keepScreenOn(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity()
                .runOnUiThread(
                        () -> {
                            if (on) {
                                getActivity()
                                        .getWindow()
                                        .addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                            } else {
                                getActivity()
                                        .getWindow()
                                        .clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                            }
                            call.resolve();
                        });
    }

    /**
     * Download an update through the system, under a name that says which one.
     *
     * <p>Called directly rather than by loading the URL in a hidden iframe, as the
     * web code used to: a github.com navigation can be claimed by Capacitor's
     * shouldOverrideUrlLoading and handed to the browser before the WebView's
     * DownloadListener ever sees it.
     */
    @PluginMethod
    public void downloadUpdate(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("no https url to download");
            return;
        }
        String fileName = call.getString("fileName", UpdateDownloader.DEFAULT_NAME);
        try {
            JSObject result = new JSObject();
            result.put("status", UpdateDownloader.enqueue(getContext(), url, fileName));
            call.resolve(result);
        } catch (RuntimeException e) {
            call.reject(e.getMessage() == null ? "the download did not start" : e.getMessage());
        }
    }

    /**
     * Save a file the page made (a GPX, a backup) into Downloads.
     *
     * <p>The page used to hand these to the WebView as an {@code <a download>}
     * of a blob: URL. A WebView has no download of its own: that reached
     * MainActivity's DownloadListener, which cannot fetch a blob: URL, and its
     * fallback crashed the app. The bytes come here instead, base64 over the
     * bridge. Downloads through MediaStore on Android 10 and later, which needs
     * no permission; before that the app's own Downloads folder, as for updates.
     */
    @PluginMethod
    public void saveFile(PluginCall call) {
        String name = call.getString("name");
        String mime = call.getString("mime", "application/octet-stream");
        String data = call.getString("data");
        if (name == null || !name.matches("[A-Za-z0-9._-]{1,120}") || data == null) {
            call.reject("nothing to save, or not a plain file name");
            return;
        }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            String where;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = getContext().getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                // hidden while it is written, so a half-written file is never
                // what the rider opens; removed again if the write fails
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) {
                    throw new IOException("Downloads refused the file");
                }
                try {
                    try (OutputStream out = resolver.openOutputStream(uri)) {
                        if (out == null) {
                            throw new IOException("Downloads gave nothing to write to");
                        }
                        out.write(bytes);
                    }
                    ContentValues done = new ContentValues();
                    done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    resolver.update(uri, done, null, null);
                } catch (IOException | RuntimeException e) {
                    resolver.delete(uri, null, null);
                    throw e;
                }
                where = "Downloads";
            } else {
                // Before Android 10 public Downloads needs a storage permission the
                // app doesn't hold, so the file goes in the app's own folder, and
                // the rider is told so rather than told "Downloads".
                File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) {
                    throw new IOException("no Downloads folder on this phone");
                }
                try (FileOutputStream out = new FileOutputStream(new File(dir, name))) {
                    out.write(bytes);
                }
                where = "the app's files (Android/data/com.pelednoam.safebikes)";
            }
            JSObject result = new JSObject();
            result.put("name", name);
            result.put("where", where);
            call.resolve(result);
        } catch (IOException | RuntimeException e) {
            call.reject(e.getMessage() == null ? "the file was not saved" : e.getMessage());
        }
    }
}
