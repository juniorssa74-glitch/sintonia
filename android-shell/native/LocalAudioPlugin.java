package app.sintonia.streams;

import android.Manifest;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Lista os arquivos de áudio do aparelho (MediaStore), sem os áudios do WhatsApp
 * e sem sons curtos (< 30s, como toques e notificações).
 * JS: Capacitor.Plugins.LocalAudio.list() -> { items: [{ id, title, artist, album, duration, path, name }] }
 */
@CapacitorPlugin(
    name = "LocalAudio",
    permissions = {
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
    }
)
public class LocalAudioPlugin extends Plugin {

    private String alias() {
        return Build.VERSION.SDK_INT >= 33 ? "audio" : "storage";
    }

    @PluginMethod
    public void list(PluginCall call) {
        if (getPermissionState(alias()) != PermissionState.GRANTED) {
            requestPermissionForAlias(alias(), call, "permissionCallback");
            return;
        }
        query(call);
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        if (getPermissionState(alias()) == PermissionState.GRANTED) {
            query(call);
        } else {
            call.reject("permission denied");
        }
    }

    private void query(PluginCall call) {
        JSArray items = new JSArray();
        Uri uri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        String[] projection = {
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.ALBUM,
            MediaStore.Audio.Media.DURATION,
            MediaStore.Audio.Media.DATA,
            MediaStore.Audio.Media.DISPLAY_NAME
        };
        String selection = MediaStore.Audio.Media.DATA + " NOT LIKE ? AND "
            + MediaStore.Audio.Media.DATA + " NOT LIKE ? AND "
            + MediaStore.Audio.Media.DURATION + " >= ?";
        String[] args = { "%WhatsApp%", "%com.whatsapp%", "30000" };
        String order = MediaStore.Audio.Media.TITLE + " COLLATE NOCASE ASC";

        try (Cursor c = getContext().getContentResolver().query(uri, projection, selection, args, order)) {
            if (c != null) {
                while (c.moveToNext()) {
                    JSObject o = new JSObject();
                    o.put("id", c.getLong(0));
                    o.put("title", c.getString(1));
                    String artist = c.getString(2);
                    o.put("artist", artist == null || artist.equals("<unknown>") ? "" : artist);
                    o.put("album", c.getString(3));
                    o.put("duration", c.getLong(4));
                    o.put("path", c.getString(5));
                    o.put("name", c.getString(6));
                    items.put(o);
                }
            }
        } catch (Exception e) {
            call.reject("query failed: " + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("items", items);
        call.resolve(ret);
    }
}
