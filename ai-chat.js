export default async function handler(req, res) {
    // אפשור CORS למקרה הצורך
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { question, systemPrompt, model } = req.body;

        // כאן הגדרנו את us-east-1 כברירת מחדל
        const region = process.env.AWS_REGION || 'us-east-1';
        const apiKey = process.env.BEDROCK_API_KEY;

        // שימוש במודל שמגיע מהמשתנים, מהבקשה, או ברירת המחדל
        const targetModel = process.env.BEDROCK_MODEL || model || "mistral.ministral-3-8b-instruct-v1:0";

        if (!apiKey) {
            return res.status(500).json({ error: "BEDROCK_API_KEY is missing in environment variables" });
        }

        // שימוש ב-Converse API שעובד באופן אחיד לכל המודלים
        const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${targetModel}/converse`;

        const payload = {
            system: [{ text: systemPrompt || "אתה מורה שיוצר שאלות לימוד בעברית. החזר JSON בלבד." }],
            messages: [{ role: "user", content: [{ text: question }] }],
            inferenceConfig: { maxTokens: 2000 }
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("AWS Bedrock Error:", errorText);
            return res.status(response.status).json({ error: `AWS Error: ${response.statusText}`, details: errorText });
        }

        const data = await response.json();
        const answerText = data.output.message.content[0].text;

        return res.status(200).json({ answer: answerText });
    } catch (error) {
        console.error("AWS Bedrock Error:", error);
        return res.status(500).json({ error: "Failed to communicate with AI provider", details: error.message });
    }
}