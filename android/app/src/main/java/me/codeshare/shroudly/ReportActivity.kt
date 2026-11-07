package me.codeshare.shroudly

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.text.DateFormat
import java.util.Date

/*
 * "Something not working?" (under the main button, MainActivity): the user
 * says what went wrong, in 50 to 1000 characters, and it goes to the
 * developer with the app's log (Report). What is sent, where it goes and
 * that our server keeps none of it are said above Send, which waits for the
 * user to agree to send it, log included. One report an hour, three a day;
 * the references sent stay listed here for 60 days. Works with a TV's remote
 * alone. The same as the desktop's dialog (components/ReportDialog.js) and
 * the Apple app's.
 */
class ReportActivity : Activity() {
    override fun attachBaseContext(base: android.content.Context) = super.attachBaseContext(Lang.wrap(base))

    private companion object {
        const val PRIVACY_URL = "https://codeshare.me/projects/shroudly/privacy"
    }

    private lateinit var form: LinearLayout
    private lateinit var done: LinearLayout
    private lateinit var past: LinearLayout
    private lateinit var what: EditText
    private lateinit var site: EditText
    private lateinit var isp: EditText
    private lateinit var country: EditText
    private lateinit var contact: EditText
    private lateinit var count: TextView
    private lateinit var agree: CheckBox
    private lateinit var status: TextView
    private lateinit var send: Button
    @Volatile private var sending = false

    private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

    private fun label(size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        setTextColor(getColor(color))
        if (bold) setTypeface(typeface, Typeface.BOLD)
        textAlignment = View.TEXT_ALIGNMENT_VIEW_START
    }

    private fun field(parent: LinearLayout, title: Int, lines: Int = 1, max: Int): EditText {
        parent.addView(label(13f, R.color.text_dim, true).apply { setText(title); setPadding(0, dp(12f), 0, dp(4f)) })
        val e = EditText(this).apply {
            setTextColor(getColor(R.color.text))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            filters = arrayOf(InputFilter.LengthFilter(max * 2))
            if (lines > 1) {
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                minLines = lines
                gravity = Gravity.TOP or Gravity.START
            } else {
                inputType = InputType.TYPE_CLASS_TEXT
                isSingleLine = true
            }
        }
        parent.addView(e, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        return e
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        Accent.apply(this)
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16f), dp(16f), dp(16f), dp(24f))
        }
        root.addView(label(20f, R.color.text, true).apply { setText(R.string.reportTitle) })
        root.addView(label(14f, R.color.text_dim).apply { setText(R.string.reportIntro); setPadding(0, dp(6f), 0, 0) })
        root.addView(label(13f, R.color.text_dim).apply { setText(R.string.reportSendDesc); setPadding(0, dp(6f), 0, 0) })

        form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(form)
        what = field(form, R.string.reportWhat, lines = 5, max = Report.WHAT_MAX)
        form.addView(label(12f, R.color.text_faint).apply { setText(R.string.reportWhatHint); setPadding(0, dp(2f), 0, 0) }, 1)
        count = label(12f, R.color.text_faint).apply { gravity = Gravity.END; textDirection = View.TEXT_DIRECTION_LTR }
        form.addView(count, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        site = field(form, R.string.reportSite, max = 300)
        isp = field(form, R.string.reportIsp, max = 120)
        country = field(form, R.string.reportCountry, max = 80)
        contact = field(form, R.string.reportContact, max = 200)

        form.addView(label(12.5f, R.color.text_dim).apply {
            text = "${getString(R.string.reportPrivacy)} ${getString(R.string.reportPrivacyProvider)}"
            setPadding(dp(12f), dp(12f), dp(12f), dp(12f))
            setBackgroundResource(R.drawable.card)
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16f) })
        form.addView(TextView(this).apply {
            setText(R.string.androidPrivacyPolicy)
            setTextColor(getColor(R.color.text_dim))
            paintFlags = paintFlags or android.graphics.Paint.UNDERLINE_TEXT_FLAG
            setPadding(0, dp(8f), 0, dp(4f))
            isFocusable = true
            setOnClickListener { open(PRIVACY_URL) }
        })
        agree = CheckBox(this).apply {
            setText(R.string.reportAgree)
            setTextColor(getColor(R.color.text))
            setOnCheckedChangeListener { _, _ -> refresh() }
        }
        form.addView(agree, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8f) })
        status = label(13f, R.color.warn).apply { visibility = View.GONE; accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        form.addView(status)
        send = Button(this).apply {
            setText(R.string.reportSend)
            setOnClickListener { submit() }
        }
        form.addView(send, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8f) })

        done = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            setPadding(dp(12f), dp(12f), dp(12f), dp(12f))
            setBackgroundResource(R.drawable.card)
        }
        root.addView(done, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16f) })

        past = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(past)

        what.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) { refresh() }
        })

        val scroll = ScrollView(this).apply { id = View.generateViewId(); addView(root); setBackgroundColor(getColor(R.color.bg)) }
        setContentView(scroll)
        Tv.rings(window)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
                @Suppress("DEPRECATION")
                window.setDecorFitsSystemWindows(false)
            }
            scroll.setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        }
        showPast()
        refresh()
    }

    private fun waitText(limit: String?) = getString(if (limit == "day") R.string.reportRateDay else R.string.reportRateHour)

    private fun refresh() {
        val n = Report.chars(what.text.toString())
        count.text = "$n / ${Report.WHAT_MAX}"
        count.setTextColor(getColor(if (n in 1 until Report.WHAT_MIN || n > Report.WHAT_MAX) R.color.warn else R.color.text_faint))
        val w = Report.wait(Report.load(this), System.currentTimeMillis())
        if (w.ms > 0 && !sending) { status.text = waitText(w.limit); status.visibility = View.VISIBLE }
        send.isEnabled = !sending && w.ms <= 0 && agree.isChecked && n in Report.WHAT_MIN..Report.WHAT_MAX
        send.setText(if (sending) R.string.reportSending else R.string.reportSend)
    }

    private fun submit() {
        if (sending) return
        val f = Report.Fields(what.text.toString(), site.text.toString(), isp.text.toString(), country.text.toString(), contact.text.toString())
        val n = Report.chars(f.what)
        if (n < Report.WHAT_MIN || n > Report.WHAT_MAX || !agree.isChecked) return
        sending = true
        status.visibility = View.GONE
        refresh()
        val ctx = applicationContext
        val platform = if (Tv.isTv(this)) "android-tv" else "android"
        val lang = resources.configuration.locales[0].toLanguageTag()
        // The Connections list, fresh: asked of the engine, and read once it
        // came (at most 3 s: a busy phone answered after the 800 ms once
        // waited, and the report said "(none)" for a session of 28).
        val on = Protection.state == Protection.State.ON
        val gen = Conns.rowsGen
        if (on) try { Protector.tell(this, ShroudlyVpnService.ACTION_CONNS, "CONNS") } catch (_: Exception) {}
        Thread({
            if (on) {
                val until = System.currentTimeMillis() + 3000
                while (Conns.rowsGen == gen && System.currentTimeMillis() < until) {
                    try { Thread.sleep(50) } catch (_: InterruptedException) { break }
                }
            }
            val log = try {
                Diagnostics.report(ctx, true) + "\n== Situation now ==\n" + Report.situation(ctx) + "\n" +
                    Report.connsSection(on, Conns.rows, Conns.lastSession, Conns.lastSessionEnded) + "\n" +
                    SiteEvents.section() + "\n"
            } catch (e: Exception) {
                "Shroudly ${BuildConfig.VERSION_NAME}: no report ($e)"
            }
            val body = Report.body(f, BuildConfig.VERSION_NAME, platform,
                "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})", "${Build.MANUFACTURER} ${Build.MODEL}", lang, log)
            val r = Report.send(body, "$platform/${BuildConfig.VERSION_NAME}", Protection.socksPort, Protection.socksAuth)
            if (r.ok && r.ref != null) Report.record(ctx, r.ref)
            AppLog.add(if (r.ok) "Report sent to the developer: ${r.ref}" else "Report not sent (${r.error})")
            runOnUiThread {
                sending = false
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (r.ok && r.ref != null) showDone(r.ref)
                else {
                    status.text = if (r.error == "rate") waitText(r.limit) else getString(R.string.reportFailed)
                    status.visibility = View.VISIBLE
                }
                showPast()
                refresh()
            }
        }, "shroudly-report").apply { isDaemon = true }.start()
    }

    private fun showDone(ref: String) {
        form.visibility = View.GONE
        done.removeAllViews()
        done.addView(label(15f, R.color.accent_light, true).apply { setText(R.string.reportSent) })
        done.addView(label(20f, R.color.text, true).apply {
            text = ref
            typeface = Typeface.MONOSPACE
            textDirection = View.TEXT_DIRECTION_LTR
            setTextIsSelectable(true)
            setPadding(0, dp(6f), 0, dp(6f))
        })
        done.addView(Button(this).apply { setText(R.string.reportCopy); setOnClickListener { copy(ref) } })
        done.addView(label(13f, R.color.text_dim).apply { setText(R.string.reportSentHint); setPadding(0, dp(6f), 0, 0) })
        done.visibility = View.VISIBLE
        done.requestFocus()
    }

    private fun showPast() {
        past.removeAllViews()
        val list = Report.load(this)
        if (list.isEmpty()) return
        past.addView(label(14f, R.color.text, true).apply { setText(R.string.reportPast); setPadding(0, dp(20f), 0, 0) })
        past.addView(label(12f, R.color.text_faint).apply { setText(R.string.reportPastHint); setPadding(0, 0, 0, dp(6f)) })
        val fmt = DateFormat.getDateInstance(DateFormat.MEDIUM)
        for (s in list) {
            past.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(12f), dp(10f), dp(12f), dp(10f))
                isFocusable = true
                isClickable = true
                setBackgroundResource(R.drawable.card)
                contentDescription = "${s.ref}, ${fmt.format(Date(s.at))}"
                setOnClickListener { copy(s.ref) }
                addView(label(14f, R.color.text).apply { text = s.ref; typeface = Typeface.MONOSPACE; textDirection = View.TEXT_DIRECTION_LTR },
                    LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                addView(label(12.5f, R.color.text_faint).apply { text = fmt.format(Date(s.at)) })
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6f) })
        }
    }

    private fun copy(ref: String) {
        try {
            getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("Shroudly", ref))
            Toast.makeText(this, getString(R.string.reportCopied), Toast.LENGTH_SHORT).show()
        } catch (_: Exception) {}
    }

    private fun open(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: Exception) {
            Toast.makeText(this, url.removePrefix("https://"), Toast.LENGTH_LONG).show()
        }
    }
}
