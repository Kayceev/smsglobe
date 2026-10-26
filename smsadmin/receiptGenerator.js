/**
 * Universal Receipt Generator for DEEMAX
 * Supports PDF and Transparent PNG formats
 * @param {Object} order - The full order object containing transaction details
 */
async function generateUniversalReceipt(order) {
    if (!order || !order.paymentReference) {
        return alert("Error: Invalid order data provided.");
    }

    // 1. Selection Prompt
    const choice = confirm("Download Options:\n\nOK: PDF (Standard White)\nCancel: IMAGE (Transparent PNG)");
    const format = choice ? 'pdf' : 'image';

    // 2. Setup the Receipt Template
    const receiptDiv = document.createElement('div');
    
    // Style for a clean, professional receipt look
    Object.assign(receiptDiv.style, {
        width: '380px',
        padding: '40px',
        background: format === 'image' ? 'rgba(255, 255, 255, 0)' : '#ffffff',
        fontFamily: "'Outfit', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        position: 'absolute',
        left: '-9999px',
        color: '#1a1a1a',
        lineHeight: '1.5'
    });

    // Formatting Data
    const date = new Date(order.createdAt || Date.now()).toLocaleDateString('en-NG', {
        year: 'numeric', month: 'long', day: 'numeric'
    });
    
    // Universal Fallbacks for different order types (Data, eSim, Fragrances, etc.)
    const serviceName = order.nodeName || order.carrier?.name || order.productName || 'Service Purchase';
    const amount = order.amount || order.amountNGN || 0;
    const target = order.targetNumber || order.recipient || 'N/A';
    const logoUrl = '/assets/logo.png';

    receiptDiv.innerHTML = `
        <div style="text-align: center; margin-bottom: 25px;">
            <img src="${logoUrl}" crossorigin="anonymous" style="max-width: 150px; margin-bottom: 10px;">
            <p style="margin: 0; font-size: 10px; color: #666; letter-spacing: 1px; text-transform: uppercase;">Official Transaction Document</p>
        </div>
        
        <div style="border-top: 1px solid #eee; border-bottom: 1px solid #eee; padding: 15px 0; margin-bottom: 20px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 12px;">
                <span style="color: #777;">Date</span>
                <span style="font-weight: 600;">${date}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 12px;">
                <span style="color: #777;">Reference</span>
                <span style="font-family: monospace; font-weight: 600;">${order.paymentReference}</span>
            </div>
        </div>

        <div style="background: ${format === 'image' ? 'rgba(0, 102, 204, 0.04)' : '#f8fbff'}; padding: 20px; border-radius: 12px; margin-bottom: 20px; border: 1px solid rgba(0, 102, 204, 0.1);">
            <p style="margin: 0 0 5px 0; font-size: 10px; text-transform: uppercase; color: #0066cc; font-weight: 800;">Order Item</p>
            <p style="margin: 0; font-size: 18px; font-weight: 700; color: #000;">${serviceName}</p>
            <div style="margin-top: 10px; font-size: 13px; color: #444;">
                <p style="margin: 3px 0;">Target: <b>${target}</b></p>
                ${order.confirmationNumber ? `<p style="margin: 3px 0;">PIN/Auth: <b>${order.confirmationNumber}</b></p>` : ''}
            </div>
        </div>

        <div style="text-align: center; padding: 20px; border: 2px dashed #e0e0e0; border-radius: 12px;">
            <p style="margin: 0; font-size: 11px; color: #888; text-transform: uppercase;">Total Paid</p>
            <h1 style="margin: 5px 0 0 0; color: #10b981; font-size: 32px;">₦${amount.toLocaleString()}</h1>
        </div>

        <div style="margin-top: 30px; text-align: center;">
            <p style="margin: 0; font-size: 11px; color: #222; font-weight: 600;">Thank you for using DEEMAX!</p>
            <p style="margin: 5px 0; font-size: 9px; color: #999;">This is a computer-generated receipt. No signature required.</p>
        </div>
    `;

    document.body.appendChild(receiptDiv);

    try {
        // Render to Canvas
        const canvas = await html2canvas(receiptDiv, {
            scale: 3, 
            backgroundColor: null,
            useCORS: true,
            logging: false
        });

        const imgData = canvas.toDataURL('image/png');

        if (format === 'image') {
            const link = document.createElement('a');
            link.download = `Deemax-${order.paymentReference}.png`;
            link.href = imgData;
            link.click();
        } else {
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF('p', 'mm', [105, 148]); // A6 size
            const pdfWidth = pdf.internal.pageSize.getWidth();
            const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
            pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
            pdf.save(`Deemax-${order.paymentReference}.pdf`);
        }
    } catch (err) {
        console.error("Receipt error:", err);
        alert("Generation failed. Check console for details.");
    } finally {
        document.body.removeChild(receiptDiv);
    }
}