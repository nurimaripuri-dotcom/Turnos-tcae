package io.github.nurimaripuri.turnostce;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.res.Resources;
import android.graphics.Color;
import android.widget.RemoteViews;
import java.util.Calendar;
import java.util.Locale;
import org.json.JSONObject;

/** Widget de 7 días desde hoy. Los datos los guarda la web vía WidgetBridgePlugin. */
public class TurnosWidget extends AppWidgetProvider {
    static final String PREFS = "turnos_widget";
    static final String KEY = "data";
    private static final String[] NAMES = {"DOM", "LUN", "MAR", "MIÉ", "JUE", "VIE", "SÁB"};
    private static final int HDR_NORMAL = 0xFFDDDDDD;
    private static final int HDR_SPECIAL = 0xFFE8A090;
    private static final int TODAY_RED = 0xFFD32F2F;
    private static final int TODAY_BG = 0xFFF8DAD7;

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) update(ctx, mgr, id);
    }

    static void updateAll(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, TurnosWidget.class));
        for (int id : ids) update(ctx, mgr, id);
    }

    private static int color(String s, int def) {
        try { return s == null || s.isEmpty() ? def : Color.parseColor(s); } catch (Exception e) { return def; }
    }

    private static int id(Resources r, String pkg, String name) {
        return r.getIdentifier(name, "id", pkg);
    }

    static void update(Context ctx, AppWidgetManager mgr, int widgetId) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_turnos);
        JSONObject days = null;
        try {
            String s = ctx.getSharedPreferences(PREFS, 0).getString(KEY, null);
            if (s != null) days = new JSONObject(s).optJSONObject("days");
        } catch (Exception ignored) {}

        Resources r = ctx.getResources();
        String pkg = ctx.getPackageName();
        Calendar c = Calendar.getInstance();
        for (int i = 0; i < 7; i++) {
            String key = String.format(Locale.US, "%04d%02d%02d",
                    c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));
            int dow = c.get(Calendar.DAY_OF_WEEK);
            boolean weekend = dow == Calendar.SATURDAY || dow == Calendar.SUNDAY;
            boolean today = i == 0;
            JSONObject d = days != null ? days.optJSONObject(key) : null;

            int hdr = id(r, pkg, "d" + i + "_hdr");
            int body = id(r, pkg, "d" + i + "_body");
            int num = id(r, pkg, "d" + i + "_num");
            int turn = id(r, pkg, "d" + i + "_turn");
            int badge = id(r, pkg, "d" + i + "_badge");

            v.setTextViewText(hdr, NAMES[dow - 1]);
            v.setInt(hdr, "setBackgroundColor", weekend ? HDR_SPECIAL : HDR_NORMAL);
            v.setTextViewText(num, String.valueOf(c.get(Calendar.DAY_OF_MONTH)));
            v.setTextColor(num, today ? TODAY_RED : Color.BLACK);
            v.setTextViewText(turn, d != null ? d.optString("t", "·") : (days == null ? "?" : "·"));
            v.setTextColor(turn, color(d != null ? d.optString("fg") : null, Color.BLACK));
            v.setInt(body, "setBackgroundColor", today ? TODAY_BG : Color.WHITE);
            int n = d != null ? d.optInt("n", 0) : 0;
            v.setTextViewText(badge, n > 0 ? (n > 1 ? n + "✉" : "✉") : "");
            c.add(Calendar.DAY_OF_MONTH, 1);
        }

        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        v.setOnClickPendingIntent(R.id.widget_root, pi);
        mgr.updateAppWidget(widgetId, v);
    }
}
