package io.github.nurimaripuri.turnostce;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Recibe desde la web los turnos ya calculados y refresca el widget. */
@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {
    @PluginMethod
    public void setData(PluginCall call) {
        String json = call.getString("json");
        if (json == null) { call.reject("sin datos"); return; }
        getContext().getSharedPreferences(TurnosWidget.PREFS, 0).edit().putString(TurnosWidget.KEY, json).apply();
        TurnosWidget.updateAll(getContext());
        call.resolve();
    }
}
