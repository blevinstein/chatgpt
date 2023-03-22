
// Convenience function for using templates hidden in HTML page
function cloneTemplate(className) {
    const template = document.querySelector(`#templateLibrary > .${className}`);
    if (!template) throw new Error(`Template not found: ${className}`);
    return template.cloneNode(true);
}
