"use strict";
/* ============================================================================
   products.js — everything shoppers browse:
     • product cards (description limited to 2 lines)
     • the home screen: the personalised "For you" feed, category chips, search
     • the product detail block that opens when a shopper taps an image or description
     • trader shop pages
   ============================================================================ */

const PAGE_SIZE = 24;   // products loaded per page ("Load more" fetches the next page)

/* ----------------------------------------------------------------------------
   Product card
   Tapping the picture, name or description opens the full product block.
   ---------------------------------------------------------------------------- */
function productCardHTML(product) {
  const available = Boolean(product.available);
  const image = imageURL(product.image);
  const shopLink = `<button class="inline-store-link" type="button" data-open-store="${escapeHTML(product.trader_username || "")}">${escapeHTML(product.store_name || "Trader shop")}</button>`;
  return `
    <article class="product-card">
      <div class="product-image-wrap" data-open-product="${product.id}" role="button" tabindex="0" aria-label="View ${escapeHTML(product.name)}">
        <span class="availability ${available ? "" : "sold-out"}">${available ? `Available · ${Number(product.stock)} left` : "Sold out"}</span>
        ${image
          ? `<img class="product-image" src="${escapeHTML(image)}" alt="${escapeHTML(product.name)}" loading="lazy" onerror="this.style.display='none'">`
          : '<div class="image-placeholder">✦<small>No photo</small></div>'}
        <button class="add-button" type="button" data-add-to-cart="${product.id}" aria-label="Add ${escapeHTML(product.name)} to cart" ${available ? "" : "disabled"}>+</button>
      </div>
      <div class="product-details">
        <p class="product-category">${escapeHTML(product.category)} · ${shopLink}</p>
        <h3 data-open-product="${product.id}">${escapeHTML(product.name)}</h3>
        <p class="product-description" data-open-product="${product.id}">${escapeHTML(product.description || "Tap to see the details.")}</p>
        <div class="product-bottom">
          <strong class="price">${formatPrice(product.price)}</strong>
          <button class="small-add" type="button" data-add-to-cart="${product.id}" ${available ? "" : "disabled"}>${available ? "Add to bag" : "Sold out"}</button>
        </div>
      </div>
    </article>`;
}

/* ----------------------------------------------------------------------------
   Home screen state
   Two modes share the same grid:
     • feed mode    — nothing typed, no category chosen → the personalised "For you" feed
     • results mode — a search and/or a category → normal, relevance-ordered results
   ---------------------------------------------------------------------------- */
const home = {
  seed: newSeed(),   // a new seed reshuffles the feed; the same seed keeps "Load more" consistent
  offset: 0,         // how many products are already on screen
  category: "",      // "" = no category chosen
  query: "",         // text in the search box
  ticket: 0          // lets us ignore slow answers to outdated requests
};

function newSeed() {
  return Math.random().toString(36).slice(2, 10);
}

function isFeedMode() {
  return !home.category && !home.query;
}

/** Update the heading above the grid and the highlighted category chip. */
function updateHomeHeading() {
  const eyebrow = document.getElementById("feed-eyebrow");
  const title = document.getElementById("feed-title");
  if (isFeedMode()) {
    eyebrow.textContent = "PICKED FOR YOU";
    title.textContent = "For you";
  } else if (home.query) {
    eyebrow.textContent = "SEARCH RESULTS";
    title.textContent = `Results for “${home.query}”${home.category ? ` in ${home.category}` : ""}`;
  } else {
    eyebrow.textContent = "CATEGORY";
    title.textContent = home.category;
  }
  document.getElementById("refresh-feed-button").hidden = !isFeedMode();
  document.querySelectorAll("#category-chips .chip").forEach(chip => {
    chip.classList.toggle("is-active", chip.dataset.category === home.category);
  });
}

/**
 * Load the grid on the home screen. Pass `true` to add the next page below what is
 * already shown ("Load more"); otherwise the grid starts again from the top.
 */
async function loadHome(appendMode) {
  const append = appendMode === true;   // event listeners pass an Event object, which must not count as "append"
  const grid = document.getElementById("market-products");
  const moreButton = document.getElementById("load-more-button");
  const ticket = ++home.ticket;

  if (!append) {
    home.offset = 0;
    grid.innerHTML = '<p class="muted">Finding products…</p>';
    moreButton.hidden = true;
    updateHomeHeading();
  }

  try {
    const url = isFeedMode()
      ? `/api/feed?seed=${encodeURIComponent(home.seed)}&limit=${PAGE_SIZE}&offset=${home.offset}`
      : `/api/products?category=${encodeURIComponent(home.category)}&q=${encodeURIComponent(home.query)}&limit=${PAGE_SIZE}&offset=${home.offset}`;
    const data = await apiRequest(url);
    if (ticket !== home.ticket) return;   // the shopper searched for something else meanwhile

    const html = data.products.map(productCardHTML).join("");
    if (append) {
      grid.insertAdjacentHTML("beforeend", html);
    } else if (html) {
      grid.innerHTML = html;
    } else {
      grid.innerHTML = isFeedMode()
        ? `<div class="empty-state"><h2>No products yet.</h2><p>Be the first to sell on S-Market Place.</p>
           <button class="primary-button" type="button" data-open-auth="trader">Open a trader shop</button></div>`
        : '<p class="muted">Nothing matched. Try different words or another category.</p>';
    }
    home.offset += data.products.length;
    moreButton.hidden = !data.has_more;
  } catch (error) {
    if (ticket !== home.ticket) return;
    if (append) showToast(error.message);
    else grid.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
  }
}

/** Draw the category chips ("For you" + every category that has products). */
async function loadCategoryChips() {
  const row = document.getElementById("category-chips");
  try {
    const { categories } = await apiRequest("/api/categories?used=1");
    row.innerHTML = '<button class="chip" type="button" data-category="">✨ For you</button>' + categories.map(category =>
      `<button class="chip" type="button" data-category="${escapeHTML(category.name)}">${escapeHTML(category.name)} <small>${category.product_count}</small></button>`).join("");
    updateHomeHeading();
  } catch (error) {
    console.error(error);
  }
}

/** A chip was tapped: filter by that category ("" goes back to the feed). */
function selectCategory(name) {
  home.category = name;
  if (name) trackInteraction("category", { category: name });   // teaches the feed what they like
  loadHome();
}

/** The Search button (or Enter) was pressed. */
function runSearch() {
  home.query = document.getElementById("market-search").value.trim();
  loadHome();
  loadTraders();
}

/** Reshuffle the feed with a fresh seed. */
function refreshFeed() {
  home.seed = newSeed();
  loadHome();
}

/* ----------------------------------------------------------------------------
   Trader shops
   ---------------------------------------------------------------------------- */
/** Show trader shops matching the search box (all shops when it is empty). */
async function loadTraders() {
  const query = document.getElementById("market-search").value.trim();
  const target = document.getElementById("trader-results");
  try {
    const traders = await apiRequest(`/api/traders?q=${encodeURIComponent(query)}`);
    target.innerHTML = traders.length ? traders.map(trader => `
      <article class="trader-card">
        <div class="trader-avatar">${trader.profile_image
          ? `<img src="${escapeHTML(trader.profile_image)}" alt="" class="avatar-image">`
          : escapeHTML((trader.store_name || trader.first_name || "T").slice(0, 1).toUpperCase())}</div>
        <div class="trader-card-copy">
          <h4>${escapeHTML(trader.store_name || `${trader.first_name} ${trader.last_name}`)}</h4>
          <p>@${escapeHTML(trader.username)} · ${trader.product_count} listed item(s)</p>
          <small>${escapeHTML(trader.store_description || "Browse this trader's products.")}</small>
        </div>
        <button type="button" class="outline-button" data-open-store="${escapeHTML(trader.username)}">Visit shop →</button>
      </article>`).join("") : '<p class="muted">No trader shops matched that search yet.</p>';
  } catch (error) {
    target.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
  }
}

/** Open one trader's public shop page. */
async function openStore(username) {
  if (!username) return;
  showPage("store");
  const grid = document.getElementById("store-products");
  grid.innerHTML = '<p class="muted">Loading this shop…</p>';
  try {
    const traders = await apiRequest(`/api/traders?q=${encodeURIComponent(username)}`);
    const trader = traders.find(item => item.username === username);
    const { products } = await apiRequest(`/api/products?trader=${encodeURIComponent(username)}&limit=100`);
    document.getElementById("store-title").textContent = trader?.store_name || `${username}'s shop`;
    document.getElementById("store-description").textContent = trader?.store_description || "Explore the products listed by this trader.";
    grid.innerHTML = products.length ? products.map(productCardHTML).join("") : '<p class="muted">This trader has not listed products yet.</p>';
  } catch (error) {
    grid.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
  }
}

/* ----------------------------------------------------------------------------
   Product detail block
   Opens when a shopper taps a product's picture, name or description. The full
   description shows here, and other items are listed underneath.
   ---------------------------------------------------------------------------- */
let returnTo = { page: "home", scroll: 0 };   // where the Back button goes

function productDetailHTML(product) {
  const available = Boolean(product.available);
  const image = imageURL(product.image);
  return `
    <div class="detail-media">${image
      ? `<img src="${escapeHTML(image)}" alt="${escapeHTML(product.name)}" onerror="this.style.display='none'">`
      : '<div class="image-placeholder">✦<small>No photo</small></div>'}</div>
    <div class="detail-info">
      <p class="product-category">${escapeHTML(product.category)} · <button class="inline-store-link" type="button" data-open-store="${escapeHTML(product.trader_username || "")}">${escapeHTML(product.store_name || "Trader shop")}</button></p>
      <h1 class="detail-title">${escapeHTML(product.name)}</h1>
      <p class="detail-price">${formatPrice(product.price)}</p>
      <span class="availability inline ${available ? "" : "sold-out"}">${available ? `Available · ${Number(product.stock)} left` : "Sold out"}</span>
      <p class="detail-description">${escapeHTML(product.description || "The trader has not added a description yet.")}</p>
      <div class="hero-actions">
        <button class="primary-button" type="button" data-add-to-cart="${product.id}" ${available ? "" : "disabled"}>${available ? "Add to bag" : "Sold out"}</button>
        <button class="outline-button" type="button" data-open-store="${escapeHTML(product.trader_username || "")}">Visit shop →</button>
      </div>
    </div>`;
}

/** Open the product block for `id`, then list related items below it. */
async function openProduct(id) {
  if (activePage !== "product") returnTo = { page: activePage, scroll: window.scrollY };   // remember where we came from
  showPage("product");
  const detail = document.getElementById("product-detail");
  const related = document.getElementById("related-products");
  detail.innerHTML = '<p class="muted">Loading…</p>';
  related.innerHTML = "";
  try {
    const { product } = await apiRequest(`/api/products/${encodeURIComponent(id)}`);
    detail.innerHTML = productDetailHTML(product);
    trackInteraction("view", { product_id: product.id });   // opening a product tells the feed what interests them
    const more = await apiRequest(`/api/products/${encodeURIComponent(id)}/related?limit=12`);
    related.innerHTML = more.products.map(productCardHTML).join("") || '<p class="muted">No other items yet.</p>';
  } catch (error) {
    detail.innerHTML = `<p class="muted">${escapeHTML(error.message)}</p>`;
  }
}

/** Back button on the product block: return to the list at the same scroll position. */
function closeProduct() {
  showPage(returnTo.page, { restoreScroll: returnTo.scroll });
}
