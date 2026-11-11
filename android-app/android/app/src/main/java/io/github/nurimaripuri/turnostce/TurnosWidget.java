package io.github.nurimaripuri.turnostce;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.res.Resources;
import android.graphics.Color;
import android.util.TypedValue;
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
        JSONObject st = new JSONObject();
        try {
            String s = ctx.getSharedPreferences(PREFS, 0).getString(KEY, null);
            if (s != null) {
                JSONObject root = new JSONObject(s);
                days = root.optJSONObject("days");
                JSONObject o = root.optJSONObject("style");
                if (o != null) st = o;
            }
        } catch (Exception ignored) {}
        // Estilo: lo manda la web (así se puede retocar sin reinstalar). Valores por defecto si falta.
        int hdrNormal = color(st.optString("hdr"), HDR_NORMAL);
        int hdrWeekend = color(st.optString("hdrWe"), HDR_SPECIAL);
        int hdrText = color(st.optString("hdrText"), Color.BLACK);
        int todayBg = color(st.optString("todayBg"), TODAY_BG);
        int cellBg = color(st.optString("cellBg"), Color.WHITE);
        int todayNum = color(st.optString("todayNum"), TODAY_RED);
        int numColor = color(st.optString("num"), Color.BLACK);
        float hdrSize = (float) st.optDouble("hdrSize", 12);
        float numSize = (float) st.optDouble("numSize", 15);
        float turnSize = (float) st.optDouble("turnSize", 26);
        float badgeSize = (float) st.optDouble("badgeSize", 14);
        // Casilla partida (V/LD/LDA + turno que tocaba): tamaños arriba/abajo
        float splitTopSize = (float) st.optDouble("splitTopSize", 15);
        float subSize = (float) st.optDouble("subSize", 18);
        String badgeChar = st.optString("badgeChar", "✉");
        boolean badgeCount1 = st.optBoolean("badgeCount1", false);

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
            int sub = id(r, pkg, "d" + i + "_sub");

            v.setTextViewText(hdr, NAMES[dow - 1]);
            v.setInt(hdr, "setBackgroundColor", weekend ? hdrWeekend : hdrNormal);
            v.setTextColor(hdr, hdrText);
            v.setTextViewTextSize(hdr, TypedValue.COMPLEX_UNIT_SP, hdrSize);
            v.setTextViewTextSize(num, TypedValue.COMPLEX_UNIT_SP, numSize);
            String subTxt = d != null ? d.optString("s", "") : "";
            boolean split = !subTxt.isEmpty();
            v.setTextViewTextSize(turn, TypedValue.COMPLEX_UNIT_SP, split ? splitTopSize : turnSize);
            if (split) {
                v.setViewVisibility(sub, android.view.View.VISIBLE);
                v.setTextViewText(sub, subTxt);
                v.setTextViewTextSize(sub, TypedValue.COMPLEX_UNIT_SP, subSize);
                v.setTextColor(sub, color(d.optString("sfg"), Color.BLACK));
                v.setInt(sub, "setBackgroundColor", color(d.optString("sbg"), Color.TRANSPARENT));
            } else {
                v.setViewVisibility(sub, android.view.View.GONE);
            }
            v.setTextViewTextSize(badge, TypedValue.COMPLEX_UNIT_SP, badgeSize);
            v.setTextViewText(num, String.valueOf(c.get(Calendar.DAY_OF_MONTH)));
            v.setTextColor(num, today ? todayNum : numColor);
            v.setTextViewText(turn, d != null ? d.optString("t", "·") : (days == null ? "?" : "·"));
            v.setTextColor(turn, color(d != null ? d.optString("fg") : null, Color.BLACK));
            v.setInt(body, "setBackgroundColor", today ? todayBg : cellBg);
            int n = d != null ? d.optInt("n", 0) : 0;
            v.setTextViewText(badge, n > 0 ? ((n > 1 || badgeCount1) ? n + badgeChar : badgeChar) : "");
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
