package me.codeshare.shroudly

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class SupportTest {
    private val data = Support.parse(
        generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "android/app/src/main/assets/donate.txt") }.first { it.exists() }.readText(),
    )

    /* The desktop's file, as gen-donate.js writes it: every account, with
     * its fields and bank. */
    @Test
    fun readsTheDesktopsAccounts() {
        assertEquals("https://www.paypal.com/donate?campaign_id=BV7WTVT9VJQQ6", data.paypal)
        assertEquals("Codeshare Technology Ltd", data.recipient)
        assertEquals(listOf("try", "gbp", "eur", "usd", "aud", "cad", "nzd", "sgd", "hkd", "php", "huf", "swift"), data.accounts.map { it.id })
        val tr = data.accountFor("TR")
        assertEquals("TRY", tr.currency)
        assertEquals(listOf("iban" to "TR63 0010 3000 0000 0082 3610 20"), tr.fields)
        assertEquals("Moka United Ödeme Hizmetleri ve Elektronik Para Kuruluşu A.Ş.", tr.bank)
        assertTrue(data.accounts.all { it.fields.isNotEmpty() && it.bank.isNotEmpty() })
    }

    /* The account by where the user sends from; anywhere else, Swift to the
     * GBP account. */
    @Test
    fun picksTheAccountForTheCountry() {
        assertEquals("eur", data.accountFor("de").id)
        assertEquals("gbp", data.accountFor("GB").id)
        assertEquals("usd", data.accountFor("US").id)
        assertEquals("huf", data.accountFor("HU").id)
        assertEquals("php", data.accountFor("PH").id)
        assertEquals("swift", data.accountFor("EG").id)
        assertEquals("swift", data.accountFor("").id)
        assertEquals("swift", data.accountFor(null).id)
        assertEquals(listOf("iban" to "GB36 TRWI 6084 6454 8100 41", "swift" to "TRWIGB2LXXX"), data.accountFor("BR").fields)
    }

    @Test
    fun noCardWhereNoWayOfGivingWorks() {
        assertFalse(data.canPayFrom("IR"))
        assertFalse(data.canPayFrom("ru"))
        assertTrue(data.canPayFrom("TR"))
        assertTrue(data.canPayFrom(""))
    }

    @Test
    fun theCardWaitsAndRests() {
        val day = 24L * 60 * 60 * 1000
        val first = 1_000_000_000_000L
        assertFalse(Support.due(first, 0, first + 2 * day))
        assertTrue(Support.due(first, 0, first + 3 * day))
        assertFalse(Support.due(first, first + 3 * day, first + 30 * day))
        assertTrue(Support.due(first, first + 3 * day, first + 63 * day))
    }

    @Test
    fun copiesWhatABanksFormTakes() {
        assertEquals("TR630010300000000082361020", Support.copyForm("iban", "TR63 0010 3000 0000 0082 3610 20"))
        assertEquals("608464", Support.copyForm("sortCode", "60-84-64"))
        assertEquals("774001", Support.copyForm("bsb", "774-001"))
        assertEquals("04-2021-0397464-38", Support.copyForm("account", "04-2021-0397464-38"))
    }
}
