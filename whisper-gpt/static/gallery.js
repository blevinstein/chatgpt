
async function fetchImages() {
    try {
        const response = await fetch('/imageLogs');
        const images = await response.json();

        const galleryContainer = document.getElementById('galleryContainer');
        images.forEach(image => {
            const imageCard = cloneTemplate('imageCard');
            imageCard.querySelector('a.imageLink').href = image.editLink;
            imageCard.querySelector('a.logLink').href = image.logLink;
            imageCard.querySelector('img').src = image.imageLink;
            galleryContainer.appendChild(imageCard);
        });
    } catch (error) {
        console.error('Error fetching prompts:', error);
    }
}


document.addEventListener('DOMContentLoaded', async () => {
    await fetchImages();
});
