package me.codeshare.shroudly

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.Resources
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.telephony.TelephonyManager
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.util.Locale

/*
 * Supporting Shroudly, as on the desktop (components/Support.js): the PayPal
 * campaign, and the bank account for the country the user sends from; from
 * anywhere else, an international (Swift) transfer to the GBP account, which
 * takes them from more than 150 countries. The data is the desktop's
 * (assets/donate.txt, made by android/scripts/gen-donate.js).
 *
 * Only in the copy from GitHub: Google Play allows no way of paying the
 * developer other than its own billing (InstallSource). The card on the main
 * window shows while protection is on, first after a few days, and after
 * "Not now" (or a look at the window) not again for two months; never as a
 * notification, and not from countries where no way of giving works.
 */
object Support {
    class Account(val id: String, val currency: String, val countries: List<String>, val fields: List<Pair<String, String>>, val bank: String)

    class Data(val paypal: String, val recipient: String, val noPay: Set<String>, val accounts: List<Account>) {
        fun accountFor(country: String?): Account {
            val c = country.orEmpty().uppercase(Locale.ROOT)
            return accounts.firstOrNull { c in it.countries } ?: accounts.first { it.id == "swift" }
        }

        fun canPayFrom(country: String?) = country.orEmpty().uppercase(Locale.ROOT) !in noPay
    }

    private const val DAY = 24L * 60 * 60 * 1000
    private const val WAIT_DAYS = 3
    private const val AGAIN_DAYS = 60
    private const val KEY_FIRST = "supportFirst"
    private const val KEY_LATER = "supportLater"

    /* assets/donate.txt: "paypal", "recipient" and "nopay" lines, then each
     * account's "account <id> <currency> <countries...>" line followed by its
     * "field <key> <value>" lines and its "bank" line. */
    fun parse(text: String): Data {
        var paypal = ""
        var recipient = ""
        var noPay = emptySet<String>()
        val heads = ArrayList<List<String>>()
        val fields = ArrayList<ArrayList<Pair<String, String>>>()
        val banks = ArrayList<String>()
        for (raw in text.lines()) {
            val line = raw.trim()
            if (line.isEmpty() || line.startsWith("#")) continue
            val kind = line.substringBefore(' ')
            val rest = line.substringAfter(' ', "")
            when (kind) {
                "paypal" -> paypal = rest
                "recipient" -> recipient = rest
                "nopay" -> noPay = rest.split(' ').filter { it.isNotEmpty() }.toSet()
                "account" -> {
                    heads.add(rest.split(' ').filter { it.isNotEmpty() })
                    fields.add(ArrayList())
                    banks.add("")
                }
                "field" -> fields.lastOrNull()?.add(rest.substringBefore(' ') to rest.substringAfter(' '))
                "bank" -> if (banks.isNotEmpty()) banks[banks.size - 1] = rest
            }
        }
        val accounts = heads.indices.map { i -> Account(heads[i][0], heads[i][1], heads[i].drop(2), fields[i], banks[i]) }
        return Data(paypal, recipient, noPay, accounts)
    }

    @Volatile private var cached: Data? = null

    fun data(ctx: Context): Data =
        cached ?: parse(ctx.assets.open("donate.txt").bufferedReader().use { it.readText() }).also { cached = it }

    /* Shown at all: the copy from GitHub. */
    fun offered(ctx: Context) = InstallSource.githubUpdates(ctx)

    /* Where the user most likely sends from: the SIM's country, else the
     * system's region (not the app's own language, which has none). */
    fun country(ctx: Context): String {
        try {
            val tm = ctx.getSystemService(TelephonyManager::class.java)
            val sim = tm?.simCountryIso.orEmpty()
            if (sim.length == 2) return sim.uppercase(Locale.ROOT)
        } catch (_: Exception) {}
        return Resources.getSystem().configuration.locales[0].country.uppercase(Locale.ROOT)
    }

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("ui", Context.MODE_PRIVATE)

    /* The card: due, and from a country where giving works. */
    fun cardDue(ctx: Context, now: Long = System.currentTimeMillis()): Boolean {
        if (!offered(ctx)) return false
        val p = prefs(ctx)
        var first = p.getLong(KEY_FIRST, 0)
        if (first == 0L) { first = now; p.edit().putLong(KEY_FIRST, now).apply() }
        return due(first, p.getLong(KEY_LATER, 0), now) && data(ctx).canPayFrom(country(ctx))
    }

    fun due(first: Long, later: Long, now: Long) = now - first >= WAIT_DAYS * DAY && now - later >= AGAIN_DAYS * DAY

    fun rest(ctx: Context) = prefs(ctx).edit().putLong(KEY_LATER, System.currentTimeMillis()).apply()

    /* What a bank's form takes: an IBAN without its spaces, a sort code or
     * BSB as digits. */
    fun copyForm(key: String, value: String) = when (key) {
        "iban" -> value.replace(" ", "")
        "sortCode", "bsb" -> value.filter { it.isDigit() }
        else -> value
    }

    /* Field names a bank's form uses in its own country stay as they are
     * there; the rest are translated. */
    private val LABELS = mapOf(
        "iban" to "IBAN", "swift" to "Swift/BIC", "sortCode" to "Sort code", "routing" to "Routing number (ACH, wire)",
        "accountType" to "Account type", "bsb" to "BSB", "institution" to "Institution number", "transit" to "Transit number",
        "bankCode" to "Bank code", "branchCode" to "Branch code", "brstn" to "BRSTN",
    )

    /* "Support Shroudly": PayPal, and the account for where the user sends
     * from (another can be picked); a tap on a line copies it. */
    @SuppressLint("SetTextI18n")
    fun show(a: Activity) {
        rest(a)
        val d = data(a)
        val dp = a.resources.displayMetrics.density
        fun px(v: Int) = (v * dp).toInt()
        val shown = a.resources.configuration.locales[0]
        fun place(acc: Account) = when (acc.id) {
            "eur" -> a.getString(R.string.supportSepa)
            "swift" -> a.getString(R.string.supportElsewhere)
            else -> Locale.Builder().setRegion(acc.countries[0]).build().getDisplayCountry(shown).ifEmpty { acc.countries[0] }
        }
        var account = d.accountFor(country(a))

        val box = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(22), px(4), px(22), px(8))
        }
        box.addView(TextView(a).apply {
            text = a.getString(R.string.supportDesc)
            setTextColor(a.getColor(R.color.text_dim))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setLineSpacing(0f, 1.1f)
        })
        box.addView(Button(a).apply {
            text = a.getString(R.string.supportPaypal)
            background = a.getDrawable(R.drawable.button_accent)
            setTextColor(a.getColor(R.color.on_accent))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            isAllCaps = false
            stateListAnimator = null
            minHeight = px(48)
            setOnClickListener { open(a, d.paypal) }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = px(16) })
        box.addView(TextView(a).apply {
            text = a.getString(R.string.supportBank)
            setTextColor(a.getColor(R.color.text))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setPadding(0, px(22), 0, px(4))
        })
        val from = TextView(a).apply {
            setTextColor(a.getColor(R.color.text))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f)
            background = a.getDrawable(R.drawable.row)
            minHeight = px(48)
            gravity = Gravity.CENTER_VERTICAL or Gravity.START
            textAlignment = View.TEXT_ALIGNMENT_VIEW_START
            setCompoundDrawablesRelative(null, null, a.getDrawable(R.drawable.ic_chevron_down)?.mutate()?.apply {
                setTint(a.getColor(R.color.text_faint))
                setBounds(0, 0, px(18), px(18))
            }, null)
            compoundDrawablePadding = px(8)
        }
        box.addView(from)
        val note = TextView(a).apply {
            text = a.getString(R.string.supportSwiftDesc)
            setTextColor(a.getColor(R.color.text_faint))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(0, px(2), 0, px(6))
        }
        box.addView(note)
        val rows = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL }
        box.addView(rows)

        fun row(label: String, value: String, copied: String) = LinearLayout(a).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = a.getDrawable(R.drawable.row)
            minimumHeight = px(52)
            setPadding(0, px(6), 0, px(6))
            contentDescription = "$label: $value"
            addView(LinearLayout(a).apply {
                orientation = LinearLayout.VERTICAL
                addView(TextView(a).apply {
                    text = label
                    setTextColor(a.getColor(R.color.text_faint))
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
                    textAlignment = View.TEXT_ALIGNMENT_VIEW_START
                })
                addView(TextView(a).apply {
                    text = value
                    setTextColor(a.getColor(R.color.text))
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                    textDirection = View.TEXT_DIRECTION_LTR
                    textAlignment = View.TEXT_ALIGNMENT_VIEW_START
                })
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(ImageView(a).apply {
                setImageResource(R.drawable.ic_copy)
                imageTintList = android.content.res.ColorStateList.valueOf(a.getColor(R.color.text_faint))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }, LinearLayout.LayoutParams(px(18), px(18)).apply { marginStart = px(10) })
            setOnClickListener { copy(a, label, copied) }
        }

        fun render() {
            from.text = "${a.getString(R.string.supportBankFrom)}: ${place(account)} · ${account.currency}"
            note.visibility = if (account.id == "swift") View.VISIBLE else View.GONE
            rows.removeAllViews()
            rows.addView(row(a.getString(R.string.supportRecipient), d.recipient, d.recipient))
            for ((k, v) in account.fields) {
                rows.addView(row(if (k == "account") a.getString(R.string.supportAccountNumber) else LABELS[k] ?: k, v, copyForm(k, v)))
            }
            rows.addView(row(a.getString(R.string.supportBankName), account.bank, account.bank))
        }
        from.setOnClickListener {
            val labels = d.accounts.map { "${place(it)} · ${it.currency}" }.toTypedArray()
            AlertDialog.Builder(a)
                .setTitle(R.string.supportBankFrom)
                .setSingleChoiceItems(labels, d.accounts.indexOf(account)) { dlg, which ->
                    account = d.accounts[which]
                    render()
                    dlg.dismiss()
                }
                .show()
        }
        render()

        AlertDialog.Builder(a)
            .setTitle(R.string.supportTitle)
            .setView(ScrollView(a).apply { addView(box) })
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    private fun copy(ctx: Context, label: String, value: String) {
        try {
            ctx.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(label, value))
            // Android 13 and later say it themselves.
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) Toast.makeText(ctx, R.string.supportCopied, Toast.LENGTH_SHORT).show()
        } catch (_: Exception) {}
    }

    private fun open(ctx: Context, url: String) {
        try { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: ActivityNotFoundException) {}
    }
}
