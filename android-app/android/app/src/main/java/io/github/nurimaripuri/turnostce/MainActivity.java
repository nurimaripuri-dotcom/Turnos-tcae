package io.github.nurimaripuri.turnostce;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WidgetBridgePlugin.class);
        registerPlugin(AppInfoPlugin.class);
        super.onCreate(savedInstanceState);
        fixTextZoom();
    }

    @Override
    public void onResume() {
        super.onResume();
        fixTextZoom();
    }

    /** Ignora el tamaño de letra del sistema para que la app se vea igual que la web en Chrome. */
    private void fixTextZoom() {
        try {
            if (bridge != null && bridge.getWebView() != null) bridge.getWebView().getSettings().setTextZoom(100);
        } catch (Exception ignored) {}
    }
}
