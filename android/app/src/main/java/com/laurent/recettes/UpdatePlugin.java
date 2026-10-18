package com.laurent.recettes;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import androidx.core.content.FileProvider;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Mise à jour in-app (même principe que Flux RSS) : télécharge l'APK de la
 * release GitHub dans le cache puis ouvre l'installeur Android.
 */
@CapacitorPlugin(name = "UpdatePlugin")
public class UpdatePlugin extends Plugin {

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String apkUrl = call.getString("url");
        if (apkUrl == null || apkUrl.isEmpty()) {
            call.reject("URL manquante");
            return;
        }

        Context ctx = getContext();
        File apkFile = new File(ctx.getCacheDir(), "recettes-update.apk");

        new Thread(() -> {
            try {
                downloadFile(apkUrl, apkFile);
                getActivity().runOnUiThread(() -> {
                    try {
                        installApk(ctx, apkFile);
                        call.resolve();
                    } catch (Exception e) {
                        call.reject("Installation impossible : " + e.getMessage());
                    }
                });
            } catch (Exception e) {
                call.reject("Erreur de téléchargement : " + e.getMessage());
            }
        }).start();
    }

    // Les assets GitHub redirigent vers un autre domaine : on suit les redirections à la main.
    private void downloadFile(String urlStr, File dest) throws IOException {
        URL url = new URL(urlStr);
        int maxRedirects = 5;
        HttpURLConnection conn = null;
        while (maxRedirects-- > 0) {
            conn = (HttpURLConnection) url.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(90_000);
            conn.connect();
            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                String location = conn.getHeaderField("Location");
                conn.disconnect();
                url = new URL(url, location);
            } else if (code != HttpURLConnection.HTTP_OK) {
                conn.disconnect();
                throw new IOException("HTTP " + code);
            } else {
                break;
            }
        }
        if (conn == null) throw new IOException("Connexion impossible");
        try (InputStream in = conn.getInputStream();
             FileOutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[16_384];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        } finally {
            conn.disconnect();
        }
    }

    /** Écrit un fichier texte (ex. CSV) dans le cache et ouvre le menu de partage Android. */
    @PluginMethod
    public void shareFile(PluginCall call) {
        String name = call.getString("name", "export.csv");
        String content = call.getString("content", "");
        String mime = call.getString("mime", "text/csv");
        try {
            Context ctx = getContext();
            File dir = new File(ctx.getCacheDir(), "exports");
            if (!dir.exists() && !dir.mkdirs()) throw new IOException("Dossier d'export impossible");
            File f = new File(dir, name.replaceAll("[^A-Za-z0-9._-]", "_"));
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(content.getBytes(StandardCharsets.UTF_8));
            }
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.putExtra(Intent.EXTRA_SUBJECT, name);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "Exporter " + name);
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            ctx.startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject("Export impossible : " + e.getMessage());
        }
    }

    private void installApk(Context ctx, File apkFile) {
        Uri apkUri = FileProvider.getUriForFile(
            ctx, ctx.getPackageName() + ".fileprovider", apkFile);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        ctx.startActivity(intent);
    }
}
