// Shareable ride cards: text summaries and rendered PNG stat cards for the
// native share sheet (chats, social, email).
export function rideShareText(ride) {
    const km = (ride.meters / 1000).toFixed(1);
    const mins = Math.round(ride.movingS / 60);
    const avg = ride.movingS > 0 ? ((ride.meters / ride.movingS) * 3.6).toFixed(1) : "0";
    const date = new Date(ride.startedAt).toLocaleDateString([], {
        month: "long",
        day: "numeric",
    });
    return (`🚲 Family bike ride, ${date}: ${km} km in ${mins} min (${avg} km/h), ` +
        `${ride.pctProtected}% on protected paths + ${ride.pctQuiet}% quiet streets. ` +
        `Planned with the Family Bike Router: https://pelednoam.github.io/safe-bikes-lanes/`);
}
export function totalsShareText(totals) {
    return (`🚲 Our family biking so far: ${totals.count} rides, ${totals.km} km total ` +
        `(${totals.thisMonthKm} km this month), longest ${totals.longestKm} km, ` +
        `${totals.avgProtectedPct}% on protected infrastructure. ` +
        `Family Bike Router: https://pelednoam.github.io/safe-bikes-lanes/`);
}
const W = 800;
const H = 420;
function cardBase() {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (ctx === null)
        return null;
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#14532d");
    grad.addColorStop(1, "#1a9850");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.font = "600 20px system-ui, sans-serif";
    ctx.fillText("🚲 Family Bike Router — Cambridge + Somerville", 32, 44);
    return { canvas, ctx };
}
function toBlob(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((b) => {
            if (b)
                resolve(b);
            else
                reject(new Error("canvas export failed"));
        }, "image/png");
    });
}
function statRow(ctx, stats, y) {
    const colW = (W - 64) / stats.length;
    stats.forEach(([value, label], i) => {
        const x = 32 + i * colW;
        ctx.fillStyle = "#ffffff";
        ctx.font = "700 40px system-ui, sans-serif";
        ctx.fillText(value, x, y);
        ctx.fillStyle = "rgba(255,255,255,.75)";
        ctx.font = "400 16px system-ui, sans-serif";
        ctx.fillText(label, x, y + 26);
    });
}
/** PNG stat card for one ride, including its route trace. */
export async function drawRideCard(ride) {
    const base = cardBase();
    if (base === null)
        throw new Error("canvas unavailable");
    const { canvas, ctx } = base;
    const date = new Date(ride.startedAt).toLocaleDateString([], {
        weekday: "long",
        month: "long",
        day: "numeric",
    });
    ctx.fillStyle = "rgba(255,255,255,.8)";
    ctx.font = "400 18px system-ui, sans-serif";
    ctx.fillText(date, 32, 78);
    const mins = Math.round(ride.movingS / 60);
    const avg = ride.movingS > 0 ? ((ride.meters / ride.movingS) * 3.6).toFixed(1) : "0";
    statRow(ctx, [
        [`${(ride.meters / 1000).toFixed(1)} km`, "distance"],
        [`${mins} min`, "moving"],
        [`${avg} km/h`, "avg speed"],
        [`${ride.pctProtected}%`, "protected"],
    ], 150);
    // route trace, normalized into the lower half
    const pts = ride.polyline;
    if (pts.length > 1) {
        const lons = pts.map((p) => p[0]);
        const lats = pts.map((p) => p[1]);
        const minLon = Math.min(...lons);
        const maxLon = Math.max(...lons);
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const pad = 40;
        const box = { x: pad, y: 210, w: W - 2 * pad, h: H - 210 - 40 };
        const spanLon = Math.max(maxLon - minLon, 1e-6);
        const spanLat = Math.max(maxLat - minLat, 1e-6);
        // keep aspect ratio-ish (lat/lon scale difference is fine for a sketch)
        const scale = Math.min(box.w / spanLon, box.h / spanLat);
        const ox = box.x + (box.w - spanLon * scale) / 2;
        const oy = box.y + (box.h - spanLat * scale) / 2;
        ctx.strokeStyle = "rgba(255,255,255,.95)";
        ctx.lineWidth = 4;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.beginPath();
        pts.forEach(([lon, lat], i) => {
            const x = ox + (lon - minLon) * scale;
            const y = oy + (maxLat - lat) * scale;
            if (i === 0)
                ctx.moveTo(x, y);
            else
                ctx.lineTo(x, y);
        });
        ctx.stroke();
    }
    return toBlob(canvas);
}
/** PNG stat card for the all-time totals. */
export async function drawTotalsCard(totals) {
    const base = cardBase();
    if (base === null)
        throw new Error("canvas unavailable");
    const { canvas, ctx } = base;
    ctx.fillStyle = "rgba(255,255,255,.8)";
    ctx.font = "400 18px system-ui, sans-serif";
    ctx.fillText("our family rides so far", 32, 78);
    statRow(ctx, [
        [`${totals.count}`, "rides"],
        [`${totals.km} km`, "total"],
        [`${totals.longestKm} km`, "longest"],
        [`${totals.avgProtectedPct}%`, "protected"],
    ], 170);
    statRow(ctx, [
        [`${totals.thisMonthKm} km`, "this month"],
        [`${totals.movingHours} h`, "time riding"],
    ], 300);
    return toBlob(canvas);
}
