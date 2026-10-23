package es.dhtrails.app;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

// A GPX, TCX or FIT shared to DH Trails from another app (a watch's app, the files app, WhatsApp, a
// download): it waits here until a page takes it (the training page puts it in its file input).
@CapacitorPlugin(name = "SharedFile")
public class SharedFilePlugin extends Plugin {
    private static final int MAX_BYTES = 20 * 1024 * 1024;   // as the server takes
    private static Uri pending = null;

    // The file an intent brings, if any: Share → DH Trails, or Open with → DH Trails.
    static boolean receive(Intent intent) {
        if (intent == null) return false;
        Uri uri = null;
        if (Intent.ACTION_SEND.equals(intent.getAction())) uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        else if (Intent.ACTION_VIEW.equals(intent.getAction())) uri = intent.getData();
        if (uri == null) return false;
        pending = uri;
        return true;
    }

    // A file arrived while the app was open.
    void announce() {
        notifyListeners("shared", new JSObject(), true);
    }

    @PluginMethod
    public void peek(PluginCall call) {
        JSObject result = new JSObject();
        result.put("pending", pending != null);
        call.resolve(result);
    }

    // The file, once: its name and its bytes in base64.
    @PluginMethod
    public void take(PluginCall call) {
        JSObject result = new JSObject();
        Uri uri = pending;
        pending = null;
        if (uri == null) {
            call.resolve(result);
            return;
        }
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[65536];
            int n, total = 0;
            while ((n = in.read(buffer)) > 0) {
                total += n;
                if (total > MAX_BYTES) throw new IllegalStateException("too big");
                out.write(buffer, 0, n);
            }
            result.put("name", nameOf(uri));
            result.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("unreadable");
        }
    }

    private String nameOf(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) return c.getString(0);
        } catch (Exception ignored) {
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "ruta";
    }
}
