module.exports = {
  index: (req, res) => {
    res.render('home', {
      pageTitle: 'Trilha do Buriti',
      subtitle: 'Aventura, Natureza e Superação',
      description:
        'Uma verdadeira festa histórica sobre duas rodas, organizada pelo grupo Alcântara Pedal Bike!🚴',
      distance: '40km',
      tipo: 'MTB',
      tempoMedio: '2:00h',
      eventDate: '22 de novembro',
      eventCity: 'Alcântara',
      organizer: 'Alcântara Pedal Bike',
      instagram: 'alcantarapedalbike',
      instagramUrl: process.env.SOCIAL_INSTAGRAM || 'https://instagram.com/alcantarapedalbike',
      whatsappGroupUrl: process.env.WHATSAPP_GROUP_URL || 'https://chat.whatsapp.com/Fqszt7Xtrcj0ragXsl9h1K?s=cl&p=i&mlu=4&amv=0',
      contacts: [
        { phone: '98 991267057', name: 'Alexandre Manzan' },
        { phone: '98 984375290', name: 'Way' },
        { phone: '98 992311910', name: 'Maurício' }
      ],
      kitItems: [
        { name: 'Medalha' },
        { name: 'Placa' },
        { name: 'Pulseira' },
        { name: 'Brindes' }
      ]
    });
  },
};