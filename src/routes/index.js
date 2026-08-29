const express = require('express');
const HomeController = require('../controllers/HomeController');
const AdminController = require('../controllers/AdminController');
const RegistrationController = require('../controllers/RegistrationController');
const GalleryController = require('../controllers/GalleryController');

const router = express.Router();

router.get('/', HomeController.index);
router.get('/galeria', GalleryController.publicPage);

// Mídia da galeria servida do banco
router.get('/media/gallery/:id', GalleryController.getMedia);

// Admin routes
router.get('/admin', AdminController.loginPage);
router.post('/admin/login', AdminController.login);
router.get('/admin/dashboard', AdminController.dashboard);
router.post('/admin/logout', AdminController.logout);
router.get('/admin/perfil', AdminController.profilePage);
router.post('/admin/perfil', AdminController.profileUpdate);
router.get('/admin/galeria', GalleryController.adminList);
// Aliases por segurança: variações de caminho
router.get('/admin/galeria/', GalleryController.adminList);
router.get('/admin/gallery', GalleryController.adminList);
router.post('/admin/galeria', GalleryController.adminCreate);
// Publicar/Despublicar removidos conforme nova regra (sempre exibir)
router.post('/admin/galeria/:id/excluir', GalleryController.adminDelete);

// Admin: inscrições
router.get('/admin/inscricoes', AdminController.registrationsList);
router.get('/admin/inscricoes/exportar-docx', AdminController.registrationsExportDocx);
router.get('/admin/inscricoes/exportar-word', AdminController.registrationsExportWord);
router.post('/admin/inscricoes/:id/confirmar', AdminController.registrationsConfirm);
router.post('/admin/inscricoes/:id/cancelar', AdminController.registrationsCancel);
router.get('/admin/inscricoes/:id/editar', AdminController.registrationsEditPage);
router.post('/admin/inscricoes/:id/editar', AdminController.registrationsEdit);
router.post('/admin/placas/corrigir-gap', AdminController.registrationsFixGap);
router.get('/admin/placas/corrigir-gap', AdminController.registrationsFixGap);

// Admin: controle de recebimento dos Kits
router.get('/admin/kits', AdminController.kitListPage);
router.post('/admin/kits/:id/recebido-proprio', AdminController.kitMarkReceivedSelf);
router.post('/admin/kits/:id/recebido-terceiro', AdminController.kitMarkReceivedThird);
router.post('/admin/kits/:id/cancelar-recebimento', AdminController.kitCancelReceived);

// Design role routes
router.get('/design', AdminController.designPage);
router.get('/design/dashboard', AdminController.designDashboard);
router.get('/design/cards-data', AdminController.designCardsData);
router.get('/design/cards-stats', AdminController.designCardsStats);

// Admin: usuários
router.get('/admin/usuarios/novo', AdminController.usersCreatePage);
router.post('/admin/usuarios/novo', AdminController.usersCreate);

// Registration routes
router.get('/inscricao', RegistrationController.formPage);
router.post('/inscricao', RegistrationController.submitWithUpload);
router.get('/inscricao/pagamento/:id', RegistrationController.paymentPage);
router.get('/inscricao/status/:id', RegistrationController.paymentStatus);
router.get('/inscricao/avatar/:id', RegistrationController.avatarPage);
router.post('/inscricao/avatar/:id', RegistrationController.uploadAvatar);
router.get('/inscricao/card/:id', RegistrationController.cardPage);
router.get('/inscricao/avatar-data/:id', RegistrationController.avatarData);
router.get('/inscricao/card-data/:id', RegistrationController.cardData);
router.get('/inscricao/card-download/:id', RegistrationController.cardDownload);
router.post('/inscricao/card-download-canvas/:id', RegistrationController.cardDownloadCanvas);
// Consulta por CPF (API)
router.post('/inscricao/consulta-cpf', RegistrationController.lookupByCpf);

// Mercado Pago webhook
router.post('/webhooks/mercadopago', RegistrationController.webhook);

module.exports = router;
