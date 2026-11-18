
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/") {
      return Response.json({
        success: true,
        message: "TalantaTickects Payment Worker is running"
      });
    }

    // Initiate M-Pesa STK Push
    if (url.pathname === "/api/mpesa/stkpush" && request.method === "POST") {
      try {
        const { phone, amount } = await request.json();

        if (!phone || !amount || Number(amount) <= 0) {
          return Response.json(
            { success: false, message: "Invalid phone or amount" },
            { status: 400 }
          );
        }

        const credentials = btoa(
          `${env.MPESA_CONSUMER_KEY}:${env.MPESA_CONSUMER_SECRET}`
        );

        const tokenResponse = await fetch(
          "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
          {
            headers: {
              Authorization: `Basic ${credentials}`
            }
          }
        );

        const tokenData = await tokenResponse.json();

        if (!tokenData.access_token) {
          return Response.json(
            { success: false, message: "Failed to obtain M-Pesa token" },
            { status: 502 }
          );
        }

        const timestamp = new Date()
          .toISOString()
          .replace(/[-:TZ.]/g, "")
          .slice(0, 14);

        const password = btoa(
          `${env.MPESA_SHORTCODE}${env.MPESA_PASSKEY}${timestamp}`
        );

        const stkResponse = await fetch(
          "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              BusinessShortCode: env.MPESA_SHORTCODE,
              Password: password,
              Timestamp: timestamp,
              TransactionType: "CustomerPayBillOnline",
              Amount: Math.round(Number(amount)),
              PartyA: phone,
              PartyB: env.MPESA_SHORTCODE,
              PhoneNumber: phone,
              CallBackURL: env.MPESA_CALLBACK_URL,
              AccountReference: "TalantaTickects",
              TransactionDesc: "Ticket Payment"
            })
          }
        );

        const result = await stkResponse.json();

        if (!stkResponse.ok) {
          return Response.json(
            { success: false, result },
            { status: 502 }
          );
        }

        if (result.CheckoutRequestID) {
          await env.DB.prepare(
            `INSERT INTO payments
            (phone, amount, checkout_request_id, status)
            VALUES (?, ?, ?, ?)`
          ).bind(
            phone,
            Math.round(Number(amount)),
            result.CheckoutRequestID,
            "PENDING"
          ).run();
        }

        return Response.json({
          success: true,
          message: "STK Push sent",
          result
        });

      } catch (error) {
        return Response.json(
          { success: false, message: error.message },
          { status: 500 }
        );
      }
    }

    // Safaricom payment callback
    if (url.pathname === "/api/mpesa/callback" && request.method === "POST") {
      try {
        const callback = await request.json();
        const data = callback.Body?.stkCallback;

        if (!data) {
          return Response.json({ ResultCode: 0, ResultDesc: "Accepted" });
        }

        const checkoutId = data.CheckoutRequestID;
        const success = data.ResultCode === 0;

        const metadata = data.CallbackMetadata?.Item || [];

        const receipt = metadata.find(
          item => item.Name === "MpesaReceiptNumber"
        )?.Value || null;

        await env.DB.prepare(
          `UPDATE payments
           SET status = ?, receipt_number = ?
           WHERE checkout_request_id = ?`
        ).bind(
          success ? "PAID" : "FAILED",
          receipt,
          checkoutId
        ).run();

        return Response.json({
          ResultCode: 0,
          ResultDesc: "Accepted"
        });

      } catch (error) {
        return Response.json(
          { ResultCode: 1, ResultDesc: "Callback processing failed" },
          { status: 500 }
        );
      }
    }

    return Response.json(
      { success: false, message: "Not found" },
      { status: 404 }
    );
  }
};
