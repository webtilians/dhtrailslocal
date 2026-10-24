package es.dhtrails.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

// DH Trails as an app: the server's pages, with the GPS going on with the screen off, and files shared to it
// from other apps.
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SharedFilePlugin.class);
        registerPlugin(MotionRecorderPlugin.class);
        super.onCreate(savedInstanceState);
        SharedFilePlugin.receive(getIntent());
        // Back goes back through the pages; on the first one it only sends the app to the background,
        // instead of closing it, so a recording goes on.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge().getWebView();
                if (web.canGoBack()) web.goBack();
                else moveTaskToBack(true);
            }
        });
        // Android 13 and later ask before showing the notification that says the GPS is recording.
        if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    // A file shared while the app was already open: the page is told, and goes to take it.
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (!SharedFilePlugin.receive(intent)) return;
        PluginHandle handle = getBridge().getPlugin("SharedFile");
        if (handle != null) ((SharedFilePlugin) handle.getInstance()).announce();
    }
}
