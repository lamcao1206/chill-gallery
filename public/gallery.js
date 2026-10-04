const grid = document.getElementById("image-grid");

const columnButtons = document.querySelectorAll(
    ".view-btn[data-columns]"
);

const fullscreenButton =
    document.getElementById("fullscreen-btn");

const paginationContainer =
    document.getElementById("reader-pagination");

const pageSizeSelect =
    document.getElementById("page-size");


let settings = {
    columns: 1,
    fullscreen: false,
    page_size: 24,
};

let currentPage = 1;


// ========================================
// Load settings
// ========================================

async function loadSettings() {
    try {
        const response = await fetch(
            "/api/settings?nocache=" + Date.now()
        );

        if (!response.ok) {
            throw new Error("Failed to load settings");
        }

        const data = await response.json();

        settings.columns = data.columns ?? 1;
        settings.fullscreen = data.fullscreen ?? false;
        settings.page_size = data.page_size ?? 24;

    } catch (error) {
        console.error("Failed to load settings:", error);

        settings = {
            columns: 1,
            fullscreen: false,
            page_size: 24,
        };
    }

    currentPage = 1;

    setColumns(settings.columns);

    if (pageSizeSelect) {
        pageSizeSelect.value = String(settings.page_size);
    }

    updateFullscreenButton();

    renderImages();
}


// ========================================
// Save settings
// ========================================

async function saveSettings() {
    try {
        const response = await fetch(
            "/api/settings",
            {
                method: "PUT",

                headers: {
                    "Content-Type": "application/json",
                },

                body: JSON.stringify(settings),
            }
        );

        if (!response.ok) {
            throw new Error("Failed to save settings");
        }

    } catch (error) {
        console.error(
            "Failed to save settings:",
            error
        );
    }
}


// ========================================
// Columns
// ========================================

function setColumns(columns) {
    if (!grid) {
        return;
    }

    columns = Number(columns);

    if (![1, 2, 3].includes(columns)) {
        columns = 1;
    }

    settings.columns = columns;

    grid.classList.remove(
        "columns-1",
        "columns-2",
        "columns-3"
    );

    grid.classList.add(
        `columns-${columns}`
    );

    columnButtons.forEach((button) => {
        button.classList.toggle(
            "active",
            button.dataset.columns === String(columns)
        );
    });
}


columnButtons.forEach((button) => {
    button.addEventListener(
        "click",
        async () => {

            setColumns(
                button.dataset.columns
            );

            await saveSettings();
        }
    );
});


// ========================================
// Page size
// ========================================

pageSizeSelect?.addEventListener(
    "change",
    async () => {

        settings.page_size =
            Number(pageSizeSelect.value);

        // Go back to page 1
        currentPage = 1;

        renderImages();

        await saveSettings();
    }
);


// ========================================
// Render images
// ========================================

function renderImages() {

    if (!grid) {
        console.error(
            "Cannot find #image-grid"
        );

        return;
    }

    if (!paginationContainer) {
        console.error(
            "Cannot find #reader-pagination"
        );

        return;
    }

    const items = Array.from(
        grid.querySelectorAll(".image-item")
    );

    const pageSize =
        Number(settings.page_size) || 24;

    const totalPages =
        Math.max(
            1,
            Math.ceil(
                items.length / pageSize
            )
        );


    // Make sure current page is valid

    if (currentPage < 1) {
        currentPage = 1;
    }

    if (currentPage > totalPages) {
        currentPage = totalPages;
    }


    const start =
        (currentPage - 1) * pageSize;

    const end =
        start + pageSize;


    // ========================================
    // Show only current page
    // ========================================

    items.forEach(
        (item, index) => {

            const visible =
                index >= start &&
                index < end;

            item.style.display =
                visible ? "" : "none";
        }
    );


    // ========================================
    // Render pagination
    // ========================================

    renderPagination(
        currentPage,
        totalPages
    );
}


// ========================================
// Pagination
// ========================================

function renderPagination(
    page,
    totalPages
) {

    if (!paginationContainer) {
        return;
    }


    // Only one page
    if (totalPages <= 1) {
        paginationContainer.innerHTML = "";
        return;
    }


    // ========================================
    // Page dropdown
    // ========================================

    let options = "";

    for (
        let i = 1;
        i <= totalPages;
        i++
    ) {

        options += `
            <option
                value="${i}"
                ${i === page ? "selected" : ""}
            >
                Page ${i} / ${totalPages}
            </option>
        `;
    }


    // ========================================
    // HTML
    // ========================================

    paginationContainer.innerHTML = `
        <div class="pagination-controls">

            <button
                type="button"
                class="pagination-btn"
                id="pagination-prev"
                ${page <= 1 ? "disabled" : ""}
            >
                ← Previous
            </button>

            <select
                id="pagination-page"
                class="pagination-page-select"
            >
                ${options}
            </select>

            <button
                type="button"
                class="pagination-btn"
                id="pagination-next"
                ${page >= totalPages ? "disabled" : ""}
            >
                Next →
            </button>

        </div>
    `;


    // ========================================
    // Previous
    // ========================================

    const previousButton =
        document.getElementById(
            "pagination-prev"
        );

    previousButton?.addEventListener(
        "click",
        () => {

            if (currentPage > 1) {

                currentPage--;

                renderImages();

                scrollToTop();
            }
        }
    );


    // ========================================
    // Next
    // ========================================

    const nextButton =
        document.getElementById(
            "pagination-next"
        );

    nextButton?.addEventListener(
        "click",
        () => {

            if (currentPage < totalPages) {

                currentPage++;

                renderImages();

                scrollToTop();
            }
        }
    );


    // ========================================
    // Page dropdown
    // ========================================

    const pageSelect =
        document.getElementById(
            "pagination-page"
        );

    pageSelect?.addEventListener(
        "change",
        () => {

            currentPage =
                Number(pageSelect.value);

            renderImages();

            scrollToTop();
        }
    );
}


// ========================================
// Scroll to top
// ========================================

function scrollToTop() {

    window.scrollTo({
        top: 0,
        behavior: "smooth",
    });
}


// ========================================
// Fullscreen
// ========================================

fullscreenButton?.addEventListener(
    "click",
    async () => {

        try {

            if (!document.fullscreenElement) {

                await document.documentElement
                    .requestFullscreen();

            } else {

                await document.exitFullscreen();
            }

        } catch (error) {

            console.error(
                "Fullscreen failed:",
                error
            );
        }
    }
);


// ========================================
// Fullscreen state
// ========================================

function updateFullscreenButton() {

    if (!fullscreenButton) {
        return;
    }

    const isFullscreen =
        Boolean(document.fullscreenElement);

    fullscreenButton.textContent =
        isFullscreen
            ? "⛶ Exit Fullscreen"
            : "⛶ Fullscreen";
}


document.addEventListener(
    "fullscreenchange",
    async () => {

        const isFullscreen =
            Boolean(document.fullscreenElement);

        settings.fullscreen =
            isFullscreen;

        updateFullscreenButton();

        await saveSettings();
    }
);


// ========================================
// Start
// ========================================

// ========================================
// Temporary remove image/video
// ========================================

grid?.addEventListener("dblclick", (event) => {
    const item = event.target.closest(".image-item");

    if (!item || !grid.contains(item)) {
        return;
    }

    // Temporarily remove from DOM
    item.remove();

    // Re-render pagination
    renderImages();
});

console.log("gallery.js loaded");

console.log(
    "Pagination element:",
    paginationContainer
);

console.log(
    "Page size element:",
    pageSizeSelect
);

loadSettings();