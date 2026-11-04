package io.github.nurimaripuri.turnostce;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WidgetBridgePlugin.class);
        registerPlugin(AppInfoPlugin.class);
        super.onCreate(savedInstanceState);
    }

}
