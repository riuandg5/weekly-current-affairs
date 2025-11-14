// Import required modules
const puppeteer = require("puppeteer");
const fs = require("fs");
const axios = require("axios");
const path = require("path");
const { execSync } = require("child_process");

// Define target websites and their PDF extraction logic
const TARGETS = [
    {
        url: "https://www.madeeasyprime.com/current-affairs",
        // Extract PDF links containing "current affairs" in their text
        dataExtractor: () => {
            const anchors = Array.from(
                document.querySelectorAll('a[href$=".pdf"]')
            );
            return anchors
                .filter((a) =>
                    a.textContent
                        .trim()
                        .toLowerCase()
                        .includes("current affairs")
                )
                .map((a) => ({
                    text: a.textContent.trim(),
                    href: a.href,
                }));
        },
    },
    {
        url: "https://www.madeeasy.in/weekly-current-affairs",
        // Extract PDF links from specific list elements
        dataExtractor: () => {
            const uls = [...document.querySelectorAll(".re-jobs ul")];
            return uls.map((ul) => ({
                text: ul.children[0].textContent.trim(),
                href: ul.children[1].children[0].href,
            }));
        },
    },
];

// Directory to save downloaded PDFs
const DOWNLOAD_DIR = path.resolve(__dirname, "Weekly Current Affairs");

// Parse end date from filename using regex
function parseEndDateFromFilename(filename) {
    const clean = filename.replace(/,/g, "");

    const match = clean.match(
        /\((?:.+?-\s*)?(\d{1,2}(?:[a-z]{2})?)\s+([A-Za-z]+)\s+(\d{4})\)/i
    );
    if (!match) return null;

    let [, day, month, year] = match;
    day = day.replace(/(st|nd|rd|th)/, "");
    const dateStr = `${day} ${month} ${year}`;
    const parsed = new Date(dateStr);
    return isNaN(parsed.getTime()) ? null : parsed;
}

(async () => {
    // Map to store unique PDFs by timestamp
    const pdfs = new Map();

    let browser = null;
    try {
        console.log("Opening browser...");
        browser = await puppeteer.launch();
        const page = await browser.newPage();

        // Iterate over each target website
        for await (const { url, dataExtractor } of TARGETS) {
            console.log("Navigating to: " + url);
            await page.goto(url, { waitUntil: "networkidle2" });

            // Scroll to load dynamic content
            console.log("Waiting for page to load...");
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let totalHeight = 0;
                    const distance = 500;
                    const timer = setInterval(() => {
                        window.scrollBy(0, distance);
                        totalHeight += distance;
                        if (totalHeight >= document.body.scrollHeight) {
                            clearInterval(timer);
                            resolve();
                        }
                    }, 300);
                });
            });

            // Extract PDF data from the page
            console.log("Searching for data...");
            (await page.evaluate(dataExtractor)).forEach((pdf) => {
                const endDate = parseEndDateFromFilename(pdf.text);
                const timestamp = endDate.getTime() / 1000;

                // Avoid duplicates (within 4 days)
                if (!pdfs.has(timestamp)) {
                    let newPdf = true;

                    for (const k of pdfs.keys()) {
                        if (Math.abs(k - timestamp) / (60 * 60 * 24) < 4) {
                            newPdf = false;
                            break;
                        }
                    }

                    if (newPdf) {
                        pdfs.set(timestamp, { ...pdf, endDate, timestamp });
                    }
                }
            });
            console.log("Searching done.");
        }
    } finally {
        // Close browser after scraping
        if (browser) {
            await browser.close();
            console.log("Browser closed.");
        }
    }

    console.log(`Found ${pdfs.size} Weekly Current Affairs PDFs`);

    // Create download directory if it doesn't exist
    if (!fs.existsSync(DOWNLOAD_DIR)) {
        fs.mkdirSync(DOWNLOAD_DIR);
    }

    // Download each PDF
    for (const { href, endDate, timestamp } of pdfs.values()) {
        const filename = `${timestamp} ${endDate.getFullYear()}-${String(
            endDate.getMonth() + 1
        ).padStart(2, "0")}-${String(endDate.getDate()).padStart(2, "0")}.pdf`;
        const filepath = path.join(DOWNLOAD_DIR, filename);

        // Skip if already downloaded
        if (fs.existsSync(filepath)) {
            console.log(`Skipping (already exists): ${filename}`);
            continue;
        }

        try {
            // Download PDF as stream
            const response = await axios.get(href, { responseType: "stream" });
            const total = parseInt(response.headers["content-length"], 10);
            let downloaded = 0;
            const writer = fs.createWriteStream(filepath);
            response.data.on("data", (chunk) => {
                downloaded += chunk.length;
                process.stdout.write(
                    `\rDownloading ${path.basename(filepath)}: ${(
                        (downloaded / total) *
                        100
                    ).toFixed(2)}%`
                );
            });
            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on("finish", resolve);
                writer.on("error", reject);
            });

            // Set file access and modification times
            fs.utimesSync(filepath, timestamp, timestamp);

            // Set file creation time on Windows
            if (process.platform === "win32") {
                const iso = endDate.toISOString();
                execSync(
                    `powershell -Command "$f=Get-Item \\"${filepath}\\"; $f.CreationTime='${iso}';"`
                );
            }

            process.stdout.write(`\rDownloaded and timestamped: ${filename}\n`);
        } catch (error) {
            console.error(`Failed to download ${filename}: ${error.message}`);
        }
    }
})();
